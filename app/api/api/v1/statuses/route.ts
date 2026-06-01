import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import {
  getActorById,
  getObjectById,
  createObject,
  createAttachment,
  deleteObject,
  getActorByUsername,
  updateActor,
  createNotification,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import {
  buildNote,
  buildCreate,
  buildDelete,
  generateId,
  actorIRI,
  followersIRI,
} from "@/lib/activitypub/utils";
import { deliverToInboxes, collectFollowerInboxes, fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { processStatusContent } from "@/lib/activitypub/content";
import { broadcastNotificationEvent } from "@/lib/streaming/broadcast";
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
  const inReplyToIdRaw = body.in_reply_to_id as string | undefined;
  const inReplyToId = inReplyToIdRaw ? decodeStatusId(inReplyToIdRaw, domain) : undefined;
  const sensitive = body.sensitive === true || body.sensitive === "true";
  const spoilerText = (body.spoiler_text as string | undefined) ?? "";
  const language = body.language as string | undefined;

  // Process content: linkify mentions, hashtags, URLs → HTML
  const { html: htmlContent, tags: contentTags } = processStatusContent(content);

  const id = generateId();
  const published = new Date().toISOString();

  const note = buildNote(baseUrl, id, {
    actorUsername: actor.username,
    content: htmlContent,
    published,
    visibility: visibility as "public" | "unlisted" | "followers" | "direct",
    inReplyTo: inReplyToId,
    sensitive,
    summary: sensitive ? spoilerText : undefined,
    language,
    tags: contentTags,
  });

  await createObject(env.DB, {
    id: note.id,
    type: "Note",
    actorId: actor.id,
    content: htmlContent,
    contentWarning: sensitive ? spoilerText : null,
    sensitive,
    visibility: visibility as "public" | "unlisted" | "followers" | "direct",
    inReplyToId: inReplyToId ?? null,
    language: language ?? null,
    url: note.url ?? note.id,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published,
    local: true,
    raw: JSON.stringify(note),
  });

  // Link any pending media attachments
  const mediaIds = (body.media_ids as string[] | undefined) ?? [];
  const linkedAttachments = [];
  for (const mediaId of mediaIds.slice(0, 4)) {
    const pendingRaw = await env.KV.get(`pending_media:${mediaId}`);
    if (!pendingRaw) continue;
    try {
      const pending = JSON.parse(pendingRaw) as Record<string, unknown>;
      const att = {
        id: mediaId,
        objectId: note.id,
        type: (pending.type as string) ?? "image",
        url: pending.url as string,
        remoteUrl: null,
        description: (pending.description as string | null) ?? null,
        blurhash: null,
        width: null,
        height: null,
        fileSize: (pending.fileSize as number | null) ?? null,
        mimeType: (pending.mimeType as string | null) ?? null,
        createdAt: new Date().toISOString(),
      };
      await createAttachment(env.DB, att);
      await env.KV.delete(`pending_media:${mediaId}`);
      linkedAttachments.push(att);
    } catch { /* skip malformed */ }
  }

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
        void broadcastNotificationEvent(env.TIMELINE_STREAM, parent.actorId).catch(() => {});
      }
    }
  }

  // Fan-out delivery
  if (visibility !== "direct") {
    const createActivity = buildCreate(baseUrl, actor.id, note, generateId());
    // Get IDs of actors who follow the current user (actor_id = follower, target_id = followed)
    const followers = await env.DB
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(actor.id)
      .all<{ actor_id: string }>();

    const followerIds = followers.results.map((r) => r.actor_id);
    const fetchActor = async (id: string): Promise<APActor | null> => {
      const cached = await getActorById(env.DB, id);
      if (cached) return cached as unknown as APActor;
      const remote = await fetchRemoteObject(id, `${actor.id}#main-key`, actor.privateKeyPem!);
      return remote as APActor | null;
    };

    const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
    if (inboxes.length > 0) {
      // Use queue for reliable delivery with automatic retries
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(createActivity), actor.id);
    }
  }

  return json(serializeStatus(
    { id: note.id, type: "Note", actorId: actor.id, content: htmlContent, contentWarning: sensitive ? spoilerText : null, sensitive, visibility: visibility as "public", inReplyToId: inReplyToId ?? null, language: language ?? null, url: note.id, repliesCount: 0, reblogsCount: 0, favouritesCount: 0, published, updatedAt: published, local: true, raw: JSON.stringify(note) },
    actor,
    domain,
    { attachments: linkedAttachments }
  ), 200);
}
