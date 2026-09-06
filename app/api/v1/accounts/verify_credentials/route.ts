import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getActorFields, setActorFields, getLastStatusAt, getAllCustomEmojis, getActorPreference } from "@/lib/db";
import { resolveLimits } from "@/lib/constants";
import { verifyAccountFields } from "@/lib/activitypub/verification";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { buildActor, buildUpdateActor, generateId } from "@/lib/activitypub/utils";
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
  const lastStatusAt = await getLastStatusAt(env.DB, actor.id);
  const quotePolicy = (await getActorPreference(env.DB, actor.id, "posting:default:quote_policy")) ?? "followers";
  const postingLanguage = (await getActorPreference(env.DB, actor.id, "posting:default:language")) ?? "en";
  const postingVisibility = (await getActorPreference(env.DB, actor.id, "posting:default:visibility")) ?? "public";
  const postingSensitive = (await getActorPreference(env.DB, actor.id, "posting:default:sensitive")) === "true";
  const hideCollections = (await getActorPreference(env.DB, actor.id, "profile:hide_collections")) === "true";
  const followRequestsRow = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM follows WHERE target_id = ? AND state = 'pending'")
    .bind(actor.id)
    .first<{ c: number }>();
  const followRequestsCount = Number(followRequestsRow?.c ?? 0);

  let role = "user";
  try {
    const row = await env.DB.prepare("SELECT role FROM actors WHERE id = ?").bind(actor.id).first<{ role: string }>();
    if (row?.role) role = row.role;
  } catch {} // column may not exist until migration runs

  // Emit `moved` (the account this one migrated to) when set.
  let movedAccount: ReturnType<typeof serializeAccount> | null = null;
  if (actor.movedTo) {
    const moved = await getActorById(env.DB, actor.movedTo);
    if (moved) {
      const movedFields = await getActorFields(env.DB, moved.id);
      movedAccount = serializeAccount(moved, domain, { fields: movedFields });
    }
  }

  return json(serializeAccount(actor, domain, { isCurrentUser: true, fields, role, lastStatusAt, moved: movedAccount, emojis: await getAllCustomEmojis(env.DB), quotePolicy, language: postingLanguage, privacy: postingVisibility, sensitive: postingSensitive, followRequestsCount, hideCollections }));
}

// PATCH /api/v1/accounts/update_credentials
export async function PATCH(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";

  let displayName: string | undefined;
  let note: string | undefined;
  let locked: boolean | undefined;
  let bot: boolean | undefined;
  let discoverable: boolean | undefined;
  let avatarUrl: string | undefined;
  let headerUrl: string | undefined;
  let fieldsRaw: { name: string; value: string }[] | undefined;
  let autoDeleteAfter: number | null | undefined;
  let sourceQuotePolicy: string | undefined;
  let sourceHideCollections: boolean | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();

    displayName = form.get("display_name") as string | undefined ?? undefined;
    note = form.get("note") as string | undefined ?? undefined;
    const lockedVal = form.get("locked") as string | null;
    if (lockedVal !== null) locked = lockedVal === "true";
    const botVal = form.get("bot") as string | null;
    if (botVal !== null) bot = botVal === "true";
    const discoverableVal = form.get("discoverable") as string | null;
    if (discoverableVal !== null) discoverable = discoverableVal === "true";
    const autoDeleteVal = form.get("auto_delete_after") as string | null;
    if (autoDeleteVal !== null) {
      autoDeleteAfter = autoDeleteVal === "" || autoDeleteVal === "0" ? null : Number(autoDeleteVal) || null;
    }
    const quotePolicyVal = form.get("source[quote_policy]") as string | null;
    if (quotePolicyVal !== null) sourceQuotePolicy = quotePolicyVal;
    const hideCollectionsVal = form.get("source[hide_collections]") as string | null;
    if (hideCollectionsVal !== null) sourceHideCollections = hideCollectionsVal === "true";

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
    for (let i = 0; i < limits.maxProfileFields; i++) {
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
    if (body.bot !== undefined) bot = body.bot === "true" || body.bot === true;
    if (body.discoverable !== undefined) discoverable = body.discoverable === "true" || body.discoverable === true;
    if (Array.isArray(body.fields)) {
      fieldsRaw = body.fields as { name: string; value: string }[];
    }
    if (body.auto_delete_after !== undefined) {
      const v = body.auto_delete_after;
      autoDeleteAfter = v === "" || v === 0 || v === "0" ? null : Number(v) || null;
    }
    if (typeof body.source === "object" && body.source !== null) {
      const src = body.source as { quote_policy?: string; hide_collections?: boolean };
      if (src.quote_policy !== undefined) sourceQuotePolicy = src.quote_policy;
      if (src.hide_collections !== undefined) sourceHideCollections = Boolean(src.hide_collections);
    }
  }

  // Enforce the same profile limits the client applies (lib/constants).
  if (displayName !== undefined && displayName.length > limits.maxDisplayNameChars) {
    return badRequest(`display_name must be ${limits.maxDisplayNameChars} characters or less`);
  }
  if (note !== undefined && note.length > limits.maxNoteChars) {
    return badRequest(`note must be ${limits.maxNoteChars} characters or less`);
  }
  if (fieldsRaw !== undefined) {
    if (fieldsRaw.length > limits.maxProfileFields) {
      return badRequest(`You can have up to ${limits.maxProfileFields} profile fields`);
    }
    if (fieldsRaw.some((f) => f.name.length > limits.maxProfileFieldChars || f.value.length > limits.maxProfileFieldChars)) {
      return badRequest(`Profile field names and values must be ${limits.maxProfileFieldChars} characters or less`);
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
  if (bot !== undefined) { setClauses.push("is_bot = ?"); values.push(bot ? 1 : 0); }
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
    // Re-check rel="me" verification in the background so the badge reflects
    // the updated fields without blocking the response.
    void verifyAccountFields(env.DB, actor.id, domain).catch(() => {});
    // Invalidate the cached federated actor so remote instances refetch the new profile.
    await env.KV.delete(`ap:actor:${actor.username.toLowerCase()}`).catch(() => {});
  }

  // Quote policy — `source[quote_policy]` (Mastodon API v7).
  if (sourceQuotePolicy !== undefined) {
    if (!["public", "followers", "followed", "nobody"].includes(sourceQuotePolicy)) {
      return json({ error: "Validation failed: quote_policy must be public, followers, followed or nobody" }, 422);
    }
    await env.DB
      .prepare(
        `INSERT INTO preferences (actor_id, key, value, updated_at) VALUES (?, 'posting:default:quote_policy', ?, datetime('now'))
         ON CONFLICT (actor_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .bind(actor.id, sourceQuotePolicy)
      .run();
  }

  // Profile preference — `source[hide_collections]` (Mastodon API v4.3).
  if (sourceHideCollections !== undefined) {
    await env.DB
      .prepare(
        `INSERT INTO preferences (actor_id, key, value, updated_at) VALUES (?, 'profile:hide_collections', ?, datetime('now'))
         ON CONFLICT (actor_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .bind(actor.id, sourceHideCollections ? "true" : "false")
      .run();
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
      alsoKnownAs: updated.alsoKnownAs ?? undefined,
      movedTo: updated.movedTo ?? undefined,
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
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(updateActivity), updated.id, `${updated.id}#main-key`, updated.privateKeyPem);
    }
  }

  const hideCollectionsAfter = sourceHideCollections !== undefined
    ? sourceHideCollections
    : (await getActorPreference(env.DB, updated.id, "profile:hide_collections")) === "true";

  return json(serializeAccount(updated, domain, { isCurrentUser: true, fields, emojis: await getAllCustomEmojis(env.DB), hideCollections: hideCollectionsAfter }));
}
