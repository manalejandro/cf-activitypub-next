import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getObjectById, getActorById, deleteObject, updateObject, updateActor, getLikedObjectIds, getAnnouncedObjectIds, getAttachmentsByObjectId, getPollByObjectId, getPollOptions, getAllCustomEmojis, getFollow, canViewStatus, getReplyToAccountId, createAttachment, createPoll, getLastStatusAtMap } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { serializeQuote } from "@/lib/mastodon/quote";
import { getObjectQuotesCount } from "@/lib/db";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { fetchAndCacheRemoteStatus } from "@/lib/activitypub/remote";
import { buildDelete, buildUpdate, buildNote, generateId } from "@/lib/activitypub/utils";
import { collectFollowerInboxes } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { processStatusContent } from "@/lib/activitypub/content";
import { broadcastObjectDelete, broadcastStatusUpdate, broadcastHomeStatusUpdate } from "@/lib/streaming/broadcast";
import type { APActor, APAttachment, APTag, LocalAttachment } from "@/lib/types";
import { resolveLimits, MIN_POLL_OPTIONS, POLL_DEFAULT_EXPIRATION } from "@/lib/constants";
import { getFilterResultsForStatuses } from "@/lib/mastodon/filters";
import { getStatusAuthorExtras } from "@/lib/mastodon/account-extras";

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

  let obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  // Remote status not cached yet (e.g. a link shared before it was ingested):
  // resolve the IRI and cache it on-demand, then serve it like any other status.
  if (!obj) {
    const iri = decodeStatusId(id, domain);
    if (/^https?:\/\//i.test(iri) && !iri.startsWith(`https://${domain}/`)) {
      const resolved = await fetchAndCacheRemoteStatus(env.DB, iri);
      if (resolved.object) obj = resolved.object;
    }
  }
  if (!obj) return notFound("Status not found");

  const author = await getActorById(env.DB, obj.actorId);
  if (!author) return notFound("Author not found");

  const authActor = await getAuthenticatedActor(request, env.DB);
  const isFollowing = authActor ? !!(await getFollow(env.DB, authActor.id, obj.actorId)) : false;
  if (!canViewStatus(obj, authActor?.id ?? null, isFollowing)) {
    return notFound("Record not found");
  }

  const [attachments, pollDb, likedIds, announcedIds, allEmojis] = await Promise.all([
    getAttachmentsByObjectId(env.DB, obj.id),
    getPollByObjectId(env.DB, obj.id),
    authActor ? getLikedObjectIds(env.DB, authActor.id, [obj.id]) : Promise.resolve(new Set<string>()),
    authActor ? getAnnouncedObjectIds(env.DB, authActor.id, [obj.id]) : Promise.resolve(new Set<string>()),
    getAllCustomEmojis(env.DB),
  ]);
  const pollOpts = pollDb ? await getPollOptions(env.DB, pollDb.id) : [];
  const poll = pollDb ? serializePoll(pollDb, pollOpts, false, []) : null;
  const inReplyToAccountId = await getReplyToAccountId(env.DB, obj);
  const [quotesCount, quote, filtered, authorLastStatusAt, authorExtras] = await Promise.all([
    getObjectQuotesCount(env.DB, obj.id),
    obj.quoteId
      ? getObjectById(env.DB, obj.quoteId).then((q) => serializeQuote(env.DB, q, domain))
      : Promise.resolve(null),
    authActor
      ? getFilterResultsForStatuses(env.DB, authActor.id, [obj]).then((m) => m.get(obj.id) ?? [])
      : Promise.resolve([]),
    getLastStatusAtMap(env.DB, [obj.actorId]).then((m) => m.get(obj.actorId) ?? null),
    getStatusAuthorExtras(env.DB, [obj.actorId], domain).then((m) => m.get(obj.actorId)),
  ]);
  return json(serializeStatus(obj, author, domain, {
    attachments,
    poll,
    favourited: likedIds.has(obj.id),
    reblogged: announcedIds.has(obj.id),
    emojis: allEmojis,
    inReplyToAccountId,
    quote,
    quotesCount,
    filtered,
    authorLastStatusAt,
    authorSupportsCalls: authorExtras?.supportsCalls,
    authorMoved: authorExtras?.moved ?? null,
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
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
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
  const pollProvided = "poll" in body;
  const pollRaw = (body.poll ?? null) as { options?: unknown; expires_in?: number; multiple?: boolean } | null;
  const hasPoll = !!pollRaw && typeof pollRaw === "object" && Array.isArray(pollRaw.options) && (pollRaw.options as unknown[]).filter((o) => String(o).trim()).length >= MIN_POLL_OPTIONS;
  if (!content && !hasPoll) return json({ error: "status content or poll is required" }, 422);

  const sensitive = body.sensitive === true || body.sensitive === "true";
  const spoilerText = (body.spoiler_text as string | undefined) ?? "";
  const language = (body.language as string | undefined) ?? obj.language ?? undefined;
  const mediaIds = Array.isArray(body.media_ids) ? (body.media_ids as string[]).slice(0, limits.maxMediaAttachments) : undefined;

  const { html: htmlContent, tags: contentTags } = processStatusContent(content ?? "", baseUrl);
  const updatedAt = new Date().toISOString();

  // Preserve the original mentions and cc (reply participants) so edits don't
  // drop them; hashtags are regenerated from the new content.
  let originalMentions: APTag[] = [];
  let originalTo: string[] | undefined;
  let originalCc: string[] | undefined;
  try {
    const raw = JSON.parse(obj.raw);
    if (Array.isArray(raw.tag)) originalMentions = (raw.tag as APTag[]).filter((t) => t.type === "Mention");
    if (Array.isArray(raw.to)) originalTo = raw.to as string[];
    if (Array.isArray(raw.cc)) originalCc = raw.cc as string[];
  } catch { /* ignore */ }
  const tags = [...originalMentions, ...(contentTags ?? []).filter((t) => t.type !== "Mention")];

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
    tags,
    to: originalTo,
    cc: originalCc,
  });
  note.attachment = (await getAttachmentsByObjectId(env.DB, obj.id)).map(toAPAttachment);
  note.updated = updatedAt;

  // If media_ids was provided, replace the status attachments with the given
  // list: existing attachments are kept (with their sensitive flag refreshed),
  // and new ids are resolved from pending media (uploaded through
  // /api/v1/media). Otherwise the current media is kept as-is.
  if (mediaIds) {
    const existing = await getAttachmentsByObjectId(env.DB, obj.id);
    const existingById = new Map(existing.map((a) => [a.id, a]));
    await env.DB.prepare("DELETE FROM attachments WHERE object_id = ?").bind(obj.id).run();
    const newAttachments: import("@/lib/types").LocalAttachment[] = [];
    for (const mediaId of mediaIds) {
      const ex = existingById.get(mediaId);
      if (ex) {
        const kept = { ...ex, sensitive: sensitive || ex.sensitive };
        await createAttachment(env.DB, kept);
        newAttachments.push(kept);
        continue;
      }
      const pendingRaw = await env.KV.get(`pending_media:${mediaId}`);
      if (!pendingRaw) continue;
      try {
        const pending = JSON.parse(pendingRaw) as Record<string, unknown>;
        const att = {
          id: mediaId,
          objectId: obj.id,
          type: (pending.type as string) ?? "image",
          url: pending.url as string,
          remoteUrl: null,
          description: (pending.description as string | null) ?? null,
          blurhash: null,
          width: null,
          height: null,
          fileSize: (pending.fileSize as number | null) ?? null,
          mimeType: (pending.mimeType as string | null) ?? null,
          sensitive: sensitive || pending.sensitive === true,
          createdAt: new Date().toISOString(),
        };
        await createAttachment(env.DB, att);
        await env.KV.delete(`pending_media:${mediaId}`);
        newAttachments.push(att);
      } catch { /* skip malformed */ }
    }
    note.attachment = newAttachments.map(toAPAttachment);
  }

  // Poll handling: when the client sends a poll field, replace the existing
  // poll (or remove it when it has no valid options). Otherwise keep as-is.
  const noteAny = note as Record<string, unknown>;
  if (pollProvided) {
    await env.DB.prepare("DELETE FROM polls WHERE object_id = ?").bind(obj.id).run();
    delete noteAny.oneOf;
    delete noteAny.anyOf;
    delete noteAny.endTime;
    delete noteAny.votersCount;
    if (hasPoll && pollRaw) {
      const pollId = generateId();
      const expiresIn = Math.min(Math.max(Number(pollRaw.expires_in ?? POLL_DEFAULT_EXPIRATION), limits.pollMinExpiration), limits.pollMaxExpiration);
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      const validOptions = (pollRaw.options as string[]).map((o) => String(o).trim()).filter(Boolean).slice(0, limits.maxPollOptions);
      await createPoll(env.DB, {
        id: pollId,
        objectId: obj.id,
        expiresAt,
        multiple: Boolean(pollRaw.multiple),
        options: validOptions.map((title, i) => ({ id: generateId(), title, position: i })),
      });
      const pollChoices = validOptions.map((title) => ({
        type: "Note",
        name: title,
        replies: { type: "Collection", totalItems: 0 },
      }));
      noteAny.type = "Question";
      if (pollRaw.multiple) noteAny.anyOf = pollChoices;
      else noteAny.oneOf = pollChoices;
      noteAny.endTime = expiresAt;
      noteAny.votersCount = 0;
    } else {
      noteAny.type = "Note";
    }
  }

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
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(updateActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
    }
  }

  const updatedObj = await getObjectById(env.DB, obj.id);
  const allEmojis = await getAllCustomEmojis(env.DB);
  const serializedUpdated = serializeStatus(updatedObj ?? obj, actor, domain, { emojis: allEmojis });

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

  // Invalidate the cached AP object so remote instances refetch the edit.
  await env.KV.delete(`ap:obj:${id}`).catch(() => {});

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
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(deleteActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
    }
  }

  // Broadcast streaming delete event to every timeline that could show it
  // (public/local/remote feeds, home feeds of local followers, hashtags, lists).
  if (env.TIMELINE_STREAM) {
    await broadcastObjectDelete(env.TIMELINE_STREAM, env.DB, obj);
  }
  await env.KV.delete(`ap:obj:${id}`).catch(() => {});

  const allEmojis = await getAllCustomEmojis(env.DB);
  const authorLastStatusAt = (await getLastStatusAtMap(env.DB, [obj.actorId])).get(obj.actorId) ?? null;
  return json(serializeStatus(obj, author ?? actor, domain, { emojis: allEmojis, authorLastStatusAt }));
}
