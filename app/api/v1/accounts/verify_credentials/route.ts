import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getActorFields, setActorFields } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { buildActor, buildUpdateActor, generateId, keyIRI } from "@/lib/activitypub/utils";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { APActor } from "@/lib/types";

// GET /api/v1/accounts/verify_credentials
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const fields = await getActorFields(env.DB, actor.id);

  let role = "user";
  try {
    const row = await env.DB.prepare("SELECT role FROM actors WHERE id = ?").bind(actor.id).first<{ role: string }>();
    if (row?.role) role = row.role;
  } catch {} // column may not exist until migration runs

  return json(serializeAccount(actor, domain, { isCurrentUser: true, fields, role }));
}

// PATCH /api/v1/accounts/update_credentials
export async function PATCH(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";

  let displayName: string | undefined;
  let note: string | undefined;
  let locked: boolean | undefined;
  let discoverable: boolean | undefined;
  let avatarUrl: string | undefined;
  let headerUrl: string | undefined;
  let fieldsRaw: { name: string; value: string }[] | undefined;
  let autoDeleteAfter: number | null | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();

    displayName = form.get("display_name") as string | undefined ?? undefined;
    note = form.get("note") as string | undefined ?? undefined;
    const lockedVal = form.get("locked") as string | null;
    if (lockedVal !== null) locked = lockedVal === "true";
    const discoverableVal = form.get("discoverable") as string | null;
    if (discoverableVal !== null) discoverable = discoverableVal === "true";
    const autoDeleteVal = form.get("auto_delete_after") as string | null;
    if (autoDeleteVal !== null) {
      autoDeleteAfter = autoDeleteVal === "" || autoDeleteVal === "0" ? null : Number(autoDeleteVal) || null;
    }

    // Handle avatar upload
    const avatarFile = form.get("avatar") as File | null;
    if (avatarFile && avatarFile.size > 0) {
      const ext = avatarFile.name.split(".").pop() ?? "bin";
      const key = `avatars/${actor.username}.${ext}`;
      await env.R2.put(key, await avatarFile.arrayBuffer(), {
        httpMetadata: { contentType: avatarFile.type },
      });
      avatarUrl = `${baseUrl}/api/media/${key}`;
    }

    // Handle header upload
    const headerFile = form.get("header") as File | null;
    if (headerFile && headerFile.size > 0) {
      const ext = headerFile.name.split(".").pop() ?? "bin";
      const key = `headers/${actor.username}.${ext}`;
      await env.R2.put(key, await headerFile.arrayBuffer(), {
        httpMetadata: { contentType: headerFile.type },
      });
      headerUrl = `${baseUrl}/api/media/${key}`;
    }

    // Handle fields — sent as fields_attributes[0][name], fields_attributes[0][value], ...
    const rawFields: { name: string; value: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const name = form.get(`fields_attributes[${i}][name]`) as string | null;
      const value = form.get(`fields_attributes[${i}][value]`) as string | null;
      if (name !== null) rawFields.push({ name: name ?? "", value: value ?? "" });
    }
    if (rawFields.length > 0) fieldsRaw = rawFields;

    // Also handle fields as JSON string
    const fieldsJson = form.get("fields") as string | null;
    if (fieldsJson) {
      try { fieldsRaw = JSON.parse(fieldsJson) as { name: string; value: string }[]; } catch { /* ignore */ }
    }
  } else {
    let body: Record<string, unknown> = {};
    try {
      if (contentType.includes("application/json")) {
        body = await request.json();
      } else {
        const form = await request.formData();
        body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
      }
    } catch { /* empty */ }

    if (body.display_name !== undefined) displayName = body.display_name as string;
    if (body.note !== undefined) note = body.note as string;
    if (body.locked !== undefined) locked = body.locked === "true" || body.locked === true;
    if (body.discoverable !== undefined) discoverable = body.discoverable === "true" || body.discoverable === true;
    if (Array.isArray(body.fields)) {
      fieldsRaw = body.fields as { name: string; value: string }[];
    }
    if (body.auto_delete_after !== undefined) {
      const v = body.auto_delete_after;
      autoDeleteAfter = v === "" || v === 0 || v === "0" ? null : Number(v) || null;
    }
  }

  // Build SET clauses dynamically
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  if (displayName !== undefined) { setClauses.push("display_name = ?"); values.push(displayName); }
  if (note !== undefined) {
    // Convert plain-text newlines to HTML <br> so the stored summary renders correctly
    const htmlNote = note
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br />");
    setClauses.push("summary = ?");
    values.push(htmlNote);
  }
  if (locked !== undefined) { setClauses.push("manually_approves_followers = ?"); values.push(locked ? 1 : 0); }
  if (discoverable !== undefined) { setClauses.push("discoverable = ?"); values.push(discoverable ? 1 : 0); }
  if (avatarUrl !== undefined) { setClauses.push("avatar_url = ?"); values.push(avatarUrl); }
  if (headerUrl !== undefined) { setClauses.push("header_url = ?"); values.push(headerUrl); }
  if (autoDeleteAfter !== undefined) { setClauses.push("auto_delete_after = ?"); values.push(autoDeleteAfter); }

  if (values.length > 0) {
    values.push(actor.id);
    await env.DB
      .prepare(`UPDATE actors SET ${setClauses.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  // Save fields if provided
  if (fieldsRaw !== undefined) {
    await setActorFields(env.DB, actor.id, fieldsRaw.filter((f) => f.name.trim()));
  }

  // Re-read using proper mapper
  const updated = await getActorById(env.DB, actor.id);
  if (!updated) return unauthorized();

  const fields = await getActorFields(env.DB, actor.id);

  // Federate profile update to all remote followers
  if (updated.privateKeyPem) {
    const apActor = buildActor(baseUrl, updated.username, {
      displayName: updated.displayName ?? undefined,
      summary: updated.summary ?? undefined,
      avatarUrl: updated.avatarUrl,
      headerUrl: updated.headerUrl,
      publicKeyPem: updated.publicKeyPem,
      manuallyApprovesFollowers: updated.manuallyApprovesFollowers,
      discoverable: updated.discoverable,
      isBot: updated.isBot,
      followersCount: updated.followersCount,
      followingCount: updated.followingCount,
      statusesCount: updated.statusesCount,
      published: updated.createdAt,
      fields: fields.map((f) => ({ name: f.name, value: f.value })),
    });
    const updateActivity = buildUpdateActor(baseUrl, apActor, generateId());
    const followerRows = await env.DB
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(updated.id)
      .all<{ actor_id: string }>();
    const followerIds = followerRows.results.map((r) => r.actor_id);
    const fetchActor = async (fid: string): Promise<APActor | null> =>
      (await getActorById(env.DB, fid)) as unknown as APActor | null;
    const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
    if (inboxes.length > 0) {
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(updateActivity), updated.id);
    }
  }

  return json(serializeAccount(updated, domain, { isCurrentUser: true, fields }));
}
