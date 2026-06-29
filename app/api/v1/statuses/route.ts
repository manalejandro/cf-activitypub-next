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
  createPoll,
  getPollByObjectId,
  getPollOptions,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
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
import { broadcastPublicStatus, broadcastHomeStatus } from "@/lib/streaming/broadcast";
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
  const pollRaw = body.poll as { options?: string[]; expires_in?: number; multiple?: boolean } | undefined;
  const hasPoll = pollRaw && Array.isArray(pollRaw.options) && pollRaw.options.filter((o) => String(o).trim()).length >= 2;
  if (!content && !hasPoll) return json({ error: "status content or poll is required" }, 422);

  const visibility = (body.visibility as string) ?? "public";
  const inReplyToIdRaw = body.in_reply_to_id as string | undefined;
  const inReplyToId = inReplyToIdRaw ? decodeStatusId(inReplyToIdRaw, domain) : undefined;
  const sensitive = body.sensitive === true || body.sensitive === "true";
  const spoilerText = (body.spoiler_text as string | undefined) ?? "";
  const language = body.language as string | undefined;

  // Process content: linkify mentions, hashtags, URLs → HTML
  const { html: htmlContent, tags: contentTags } = processStatusContent(content ?? "");

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
  // note.attachment will be set after linkedAttachments is populated below

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

  // Create poll if provided
  let serializedPoll = null;
  if (hasPoll && pollRaw) {
    const pollId = generateId();
    const expiresIn = Math.min(Math.max(Number(pollRaw.expires_in ?? 86400), 300), 2592000);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const validOptions = (pollRaw.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 4);
    await createPoll(env.DB, {
      id: pollId,
      objectId: note.id,
      expiresAt,
      multiple: Boolean(pollRaw.multiple),
      options: validOptions.map((title, i) => ({ id: generateId(), title, position: i })),
    });
    const pollDb = await getPollByObjectId(env.DB, note.id);
    const pollOpts = await getPollOptions(env.DB, pollId);
    if (pollDb) serializedPoll = serializePoll(pollDb, pollOpts, false, []);

    // Attach poll data to the AP object so remote instances receive a Question
    const pollChoices = validOptions.map((title) => ({
      type: "Note",
      name: title,
      replies: { type: "Collection", totalItems: 0 },
    }));
    const noteAny = note as Record<string, unknown>;
    noteAny.type = "Question";
    if (pollRaw.multiple) {
      noteAny.anyOf = pollChoices;
    } else {
      noteAny.oneOf = pollChoices;
    }
    noteAny.endTime = expiresAt;
    noteAny.votersCount = 0;
  }

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

  // Create notifications for mentioned local users
  const localMentionPattern = /^\/(?:users\/)?([a-zA-Z0-9_]+)$/;
  for (const tag of contentTags) {
    if (tag.type === "Mention" && tag.href && tag.href !== actor.id) {
      const localMatch = tag.href.match(localMentionPattern) ?? tag.href.match(/https:\/\/[^/]+\/users\/([a-zA-Z0-9_]+)$/);
      if (localMatch) {
        const mentioned = await getActorByUsername(env.DB, localMatch[1], domain);
        if (mentioned && mentioned.id !== actor.id) {
          await createNotification(env.DB, {
            id: generateId(),
            type: "mention",
            accountId: actor.id,
            targetAccountId: mentioned.id,
            objectId: note.id,
            read: false,
            createdAt: published,
          });
        }
      }
    }
  }

  // Attach media to AP Note now that linkedAttachments is populated
  if (linkedAttachments.length > 0) note.attachment = linkedAttachments.map(toAPAttachment);

  // Update stored raw to include poll + attachment fields added after initial createObject.
  // Use a direct query to avoid bumping updated_at (these are not user edits).
  if (hasPoll || linkedAttachments.length > 0) {
    await env.DB
      .prepare("UPDATE objects SET raw = ? WHERE id = ?")
      .bind(JSON.stringify(note), note.id)
      .run();
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

  const serializedStatus = serializeStatus(
    { id: note.id, type: "Note", actorId: actor.id, content: htmlContent, contentWarning: sensitive ? spoilerText : null, sensitive, visibility: visibility as "public", inReplyToId: inReplyToId ?? null, language: language ?? null, url: note.id, repliesCount: 0, reblogsCount: 0, favouritesCount: 0, published, updatedAt: published, local: true, raw: JSON.stringify(note) },
    actor,
    domain,
    { attachments: linkedAttachments, poll: serializedPoll }
  );

  // Broadcast to streaming clients — collect tasks and await all together
  const broadcastTasks: Promise<void>[] = [];
  if (visibility === "public" || visibility === "unlisted") {
    broadcastTasks.push(broadcastPublicStatus(env.TIMELINE_STREAM, serializedStatus, /* isLocal */ true));
  }
  broadcastTasks.push(broadcastHomeStatus(env.TIMELINE_STREAM, actor.id, serializedStatus));
  const localFollowerRows = await env.DB
    .prepare("SELECT a.id FROM actors a JOIN follows f ON f.actor_id = a.id WHERE f.target_id = ? AND f.state = 'accepted' AND a.is_local = 1")
    .bind(actor.id)
    .all<{ id: string }>();
  for (const row of localFollowerRows.results) {
    broadcastTasks.push(broadcastHomeStatus(env.TIMELINE_STREAM, row.id, serializedStatus));
  }
  await Promise.allSettled(broadcastTasks);

  return json(serializedStatus, 200);
}
