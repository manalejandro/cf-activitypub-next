import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getObjectById, getActorById, deleteObject, updateObject, updateActor, createLike, deleteLike, getLike, getLikedObjectIds, createAnnounce, deleteAnnounce, getAnnounce, getAnnouncedObjectIds, getAttachmentsByObjectId, getPollByObjectId, getPollOptions } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { decodeStatusId, encodeStatusId } from "@/lib/mastodon/statusId";
import { buildDelete, buildUpdate, buildNote, buildLike, buildAnnounce, buildUndo, generateId, followersIRI } from "@/lib/activitypub/utils";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { processStatusContent } from "@/lib/activitypub/content";
import { broadcastDelete, broadcastHomeDelete, broadcastStatusUpdate, broadcastHomeStatusUpdate } from "@/lib/streaming/broadcast";
import type { APActor, APAttachment, LocalAttachment } from "@/lib/types";

function toAPAttachment(att: LocalAttachment): APAttachment {
  const mimeType = att.mimeType ?? "application/octet-stream";
  let type: APAttachment["type"] = "Document";
  if (mimeType.startsWith("image/")) type = "Image";
  else if (mimeType.startsWith("video/")) type = "Video";
  else if (mimeType.startsWith("audio/")) type = "Audio";
  return {
    id: att.url,
    type,
    mediaType: mimeType,
    url: att.url,
    ...(att.description ? { name: att.description } : {}),
    ...(att.blurhash ? { blurhash: att.blurhash } : {}),
    ...(att.width != null ? { width: att.width } : {}),
    ...(att.height != null ? { height: att.height } : {}),
  };
}

// GET /api/v1/statuses/:id
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");

  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound("Author not found");

  const authActor = await getAuthenticatedActor(request, env.DB);

  const [attachments, pollDb, likedIds, announcedIds] = await Promise.all([
    getAttachmentsByObjectId(env.DB, obj.id),
    getPollByObjectId(env.DB, obj.id),
    authActor ? getLikedObjectIds(env.DB, authActor.id, [obj.id]) : Promise.resolve(new Set<string>()),
    authActor ? getAnnouncedObjectIds(env.DB, authActor.id, [obj.id]) : Promise.resolve(new Set<string>()),
  ]);
  const pollOpts = pollDb ? await getPollOptions(env.DB, pollDb.id) : [];
  const poll = pollDb ? serializePoll(pollDb, pollOpts, false, []) : null;
  return json(serializeStatus(obj, author, domain, {
    attachments,
    poll,
    favourited: likedIds.has(obj.id),
    reblogged: announcedIds.has(obj.id),
  }));
}

// PUT /api/v1/statuses/:id — Edit an existing status
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();
  if (!actor.privateKeyPem) return json({ error: "Account misconfigured" }, 500);

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");
  if (obj.actorId !== actor.id) return json({ error: "Forbidden" }, 403);
  if (!obj.local) return json({ error: "Cannot edit remote status" }, 403);

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

  const sensitive = body.sensitive === true || body.sensitive === "true";
  const spoilerText = (body.spoiler_text as string | undefined) ?? "";
  const language = (body.language as string | undefined) ?? obj.language ?? undefined;

  const { html: htmlContent, tags: contentTags } = processStatusContent(content);
  const updatedAt = new Date().toISOString();

  // Rebuild the Note with the same ID and original published date but new content
  const noteLocalId = obj.id.replace(`${baseUrl}/objects/`, "");
  const note = buildNote(baseUrl, noteLocalId, {
    actorUsername: actor.username,
    content: htmlContent,
    published: obj.published,
    visibility: obj.visibility as "public" | "unlisted" | "followers" | "direct",
    inReplyTo: obj.inReplyToId ?? undefined,
    sensitive,
    summary: sensitive ? spoilerText : undefined,
    language,
    tags: contentTags,
  });
  note.attachment = (await getAttachmentsByObjectId(env.DB, obj.id)).map(toAPAttachment);
  note.updated = updatedAt;

  await updateObject(env.DB, obj.id, {
    content: htmlContent,
    contentWarning: sensitive ? spoilerText : null,
    sensitive,
    language: language ?? null,
    raw: JSON.stringify(note),
  });

  // Fan-out Update activity to followers
  if (obj.visibility !== "direct") {
    const updateActivity = buildUpdate(baseUrl, actor.id, note, generateId());
    const followers = await env.DB
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(actor.id)
      .all<{ actor_id: string }>();
    const followerIds = followers.results.map((r) => r.actor_id);
    const fetchActor = async (fid: string): Promise<APActor | null> => {
      const cached = await getActorById(env.DB, fid);
      return cached as unknown as APActor | null;
    };
    const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
    if (inboxes.length > 0) {
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(updateActivity), actor.id);
    }
  }

  const updatedObj = await getObjectById(env.DB, obj.id);
  const serializedUpdated = serializeStatus(updatedObj ?? obj, actor, domain);

  // Broadcast status.update event to streaming clients
  if (env.TIMELINE_STREAM) {
    const broadcastTasks: Promise<void>[] = [
      broadcastStatusUpdate(env.TIMELINE_STREAM, serializedUpdated, /* isLocal */ true),
      broadcastHomeStatusUpdate(env.TIMELINE_STREAM, actor.id, serializedUpdated),
    ];
    const localFollowerRows = await env.DB
      .prepare("SELECT a.id FROM actors a JOIN follows f ON f.actor_id = a.id WHERE f.target_id = ? AND f.state = 'accepted' AND a.is_local = 1")
      .bind(actor.id)
      .all<{ id: string }>();
    for (const row of localFollowerRows.results) {
      broadcastTasks.push(broadcastHomeStatusUpdate(env.TIMELINE_STREAM, row.id, serializedUpdated));
    }
    await Promise.allSettled(broadcastTasks);
  }

  return json(serializedUpdated);
}

// DELETE /api/v1/statuses/:id
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");
  if (obj.actorId !== actor.id) return json({ error: "Forbidden" }, 403);

  const author = await getActorById(env.DB, obj.actorId);
  // Capture the encoded status ID before deletion (needed for streaming delete event)
  const encodedStatusId = encodeStatusId(obj.id, obj.local);
  await deleteObject(env.DB, obj.id);
  await updateActor(env.DB, actor.id, { statusesCount: Math.max(0, actor.statusesCount - 1) });

  // Deliver Delete activity to remote followers
  if (actor.privateKeyPem) {
    const deleteActivity = buildDelete(baseUrl, actor.id, obj.id, generateId());
    const followers = await env.DB
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(actor.id)
      .all<{ actor_id: string }>();

    const followerIds = followers.results.map((r) => r.actor_id);
    const fetchActor = async (id: string): Promise<APActor | null> => {
      const cached = await getActorById(env.DB, id);
      return cached as unknown as APActor | null;
    };
    const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
    if (inboxes.length > 0) {
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(deleteActivity), actor.id);
    }
  }

  // Broadcast streaming delete event
  if (env.TIMELINE_STREAM) {
    const isPublic = obj.visibility === "public";
    const broadcastTasks: Promise<void>[] = [
      broadcastDelete(env.TIMELINE_STREAM, encodedStatusId, isPublic, /* isLocal */ true),
      broadcastHomeDelete(env.TIMELINE_STREAM, actor.id, encodedStatusId),
    ];
    const localFollowerRows = await env.DB
      .prepare("SELECT a.id FROM actors a JOIN follows f ON f.actor_id = a.id WHERE f.target_id = ? AND f.state = 'accepted' AND a.is_local = 1")
      .bind(actor.id)
      .all<{ id: string }>();
    for (const row of localFollowerRows.results) {
      broadcastTasks.push(broadcastHomeDelete(env.TIMELINE_STREAM, row.id, encodedStatusId));
    }
    await Promise.allSettled(broadcastTasks);
  }

  return json(serializeStatus(obj, author ?? actor, domain));
}
