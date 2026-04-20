import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import {
  getActorById,
  getObjectById,
  createObject,
  deleteObject,
  getActorByUsername,
  updateActor,
  createNotification,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import {
  buildNote,
  buildCreate,
  buildDelete,
  generateId,
  actorIRI,
  followersIRI,
} from "@/lib/activitypub/utils";
import { deliverToInboxes, collectFollowerInboxes, fetchRemoteObject } from "@/lib/activitypub/federation";
import type { APActor } from "@/lib/types";

// POST /api/v1/statuses — Publish a new status
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();
  if (!actor.privateKeyPem) return json({ error: "Account misconfigured" }, 500);

  let body: Record<string, unknown>;
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    const form = await request.formData();
    body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  }

  const content = (body.status as string | undefined)?.trim();
  if (!content) return json({ error: "status content is required" }, 422);

  const visibility = (body.visibility as string) ?? "public";
  const inReplyToId = body.in_reply_to_id as string | undefined;
  const sensitive = body.sensitive === true || body.sensitive === "true";
  const spoilerText = (body.spoiler_text as string | undefined) ?? "";
  const language = body.language as string | undefined;

  const id = generateId();
  const published = new Date().toISOString();

  const note = buildNote(baseUrl, id, {
    actorUsername: actor.username,
    content,
    published,
    visibility: visibility as "public" | "unlisted" | "followers" | "direct",
    inReplyTo: inReplyToId,
    sensitive,
    summary: sensitive ? spoilerText : undefined,
    language,
  });

  await createObject(env.DB, {
    id: note.id,
    type: "Note",
    actorId: actor.id,
    content,
    contentWarning: sensitive ? spoilerText : null,
    sensitive,
    visibility: visibility as "public" | "unlisted" | "followers" | "direct",
    inReplyToId: inReplyToId ?? null,
    language: language ?? null,
    url: note.id,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published,
    local: true,
    raw: JSON.stringify(note),
  });

  // Update actor status count
  await updateActor(env.DB, actor.id, { statusesCount: actor.statusesCount + 1 });

  // If it's a reply, increment replies count on parent
  if (inReplyToId) {
    await env.DB
      .prepare("UPDATE objects SET replies_count = replies_count + 1 WHERE id = ?")
      .bind(inReplyToId)
      .run();

    const parent = await getObjectById(env.DB, inReplyToId);
    if (parent) {
      const parentOwner = await getActorById(env.DB, parent.actorId);
      if (parentOwner && parentOwner.id !== actor.id) {
        await createNotification(env.DB, {
          id: generateId(),
          type: "mention",
          accountId: actor.id,
          targetAccountId: parent.actorId,
          objectId: note.id,
          read: false,
          createdAt: published,
        });
      }
    }
  }

  // Fan-out delivery
  if (visibility !== "direct") {
    const createActivity = buildCreate(baseUrl, actor.id, note, generateId());
    const followers = await env.DB
      .prepare("SELECT target_id FROM follows WHERE actor_id = ? AND state = 'accepted'")
      .bind(actor.id)
      .all<{ target_id: string }>();

    const followerIds = followers.results.map((r) => r.target_id);
    const fetchActor = async (id: string): Promise<APActor | null> => {
      const cached = await getActorById(env.DB, id);
      if (cached) return cached as unknown as APActor;
      const remote = await fetchRemoteObject(id, `${actor.id}#main-key`, actor.privateKeyPem!);
      return remote as APActor | null;
    };

    const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
    if (inboxes.length > 0) {
      await deliverToInboxes(inboxes, createActivity, `${actor.id}#main-key`, actor.privateKeyPem);
    }
  }

  return json(serializeStatus(
    { id: note.id, type: "Note", actorId: actor.id, content, contentWarning: sensitive ? spoilerText : null, sensitive, visibility: visibility as "public", inReplyToId: inReplyToId ?? null, language: language ?? null, url: note.id, repliesCount: 0, reblogsCount: 0, favouritesCount: 0, published, updatedAt: published, local: true, raw: JSON.stringify(note) },
    actor,
    domain
  ), 200);
}
