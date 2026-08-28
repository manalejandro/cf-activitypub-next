import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import {
  getActorById,
  getObjectById,
  createObject,
  createAttachment,
  getActorByUsername,
  updateActor,
  createPoll,
  getPollByObjectId,
  getPollOptions,
  getAttachmentsByObjectId,
  getAllCustomEmojis,
  createScheduledStatus,
  upsertDirectConversation,
  getActorPreference,
  isActorBlockedBy,
  getFollow,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { serializeStatus, serializePoll } from "@/lib/mastodon/serializers";
import { serializeQuote } from "@/lib/mastodon/quote";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import {
  buildNote,
  buildCreate,
  generateId,
  followersIRI,
  isLocalIRI,
} from "@/lib/activitypub/utils";
import { collectFollowerInboxes, fetchRemoteObject } from "@/lib/activitypub/federation";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import { processStatusContent } from "@/lib/activitypub/content";
import { fetchAndCacheRemoteStatus } from "@/lib/activitypub/remote";
import { buildReplyMentions, collectThreadParticipants, expandBareMentions, mentionKey, type ThreadNode } from "@/lib/activitypub/replies";
import { PUBLIC_ADDRESS } from "@/lib/activitypub/vocab";
import { broadcastPublicStatus, broadcastHomeStatus } from "@/lib/streaming/broadcast";
import { notify } from "@/lib/notify";
import { screenStatus } from "@/lib/moderation/pipeline";
import type { APActor, APAttachment, APTag, LocalActor, LocalAttachment } from "@/lib/types";

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
    ...(att.sensitive ? { sensitive: true } : {}),
  };
}

/** Fetch a remote status that is being replied to but isn't cached locally. */
async function fetchReplyParent(actor: LocalActor, iri: string): Promise<ThreadNode | null> {
  try {
    const fetched = await fetchRemoteObject(iri, `${actor.id}#main-key`, actor.privateKeyPem!);
    if (!fetched || typeof fetched !== "object") return null;
    const note = fetched as {
      attributedTo?: string | { id?: string };
      inReplyTo?: string;
      tag?: APTag[];
    };
    const attributedTo =
      typeof note.attributedTo === "string" ? note.attributedTo : note.attributedTo?.id ?? null;
    return {
      actorId: attributedTo,
      inReplyToId: note.inReplyTo ?? null,
      mentions: note.tag,
    };
  } catch {
    return null;
  }
}

// Whether `actor` is allowed to quote `author`'s status given the author's
// quote policy (Mastodon: public → anyone, followers → followers+author,
// followed → accounts the author follows, nobody → only the author).
async function quoteAllowed(
  db: D1Database,
  actor: { id: string },
  author: { id: string },
  policy: string
): Promise<boolean> {
  if (actor.id === author.id) return true;
  // Blocked users are never allowed to quote.
  if (await isActorBlockedBy(db, author.id, actor.id)) return false;
  switch (policy) {
    case "public":
      return true;
    case "followers":
      return !!(await getFollow(db, actor.id, author.id));
    case "followed":
      return !!(await getFollow(db, author.id, actor.id));
    default:
      return false; // nobody
  }
}

// POST /api/v1/statuses — Publish a new status
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();
  if (!actor.privateKeyPem) return json({ error: "Account misconfigured" }, 500);

  // Idempotency-Key: prevent duplicate status submissions within 1 hour.
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey) {
    const existingId = await env.KV.get(`idempotency:${actor.id}:${idempotencyKey}`);
    if (existingId) {
      const existing = await getObjectById(env.DB, existingId);
      if (existing) {
        const existingAuthor = await getActorById(env.DB, existing.actorId);
        if (existingAuthor) {
          const existingPoll = await getPollByObjectId(env.DB, existing.id);
          const existingPollOpts = existingPoll ? await getPollOptions(env.DB, existingPoll.id) : [];
          const attachments = await getAttachmentsByObjectId(env.DB, existing.id);
          return json(serializeStatus(existing, existingAuthor, domain, {
            attachments,
            poll: existingPoll ? serializePoll(existingPoll, existingPollOpts, false, []) : null,
          }));
        }
      }
    }
  }

  let body: Record<string, unknown>;
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    const form = await request.formData();
    body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  }

  let content = (body.status as string | undefined)?.trim();
  const pollRaw = body.poll as { options?: string[]; expires_in?: number; multiple?: boolean } | undefined;
  const hasPoll = pollRaw && Array.isArray(pollRaw.options) && pollRaw.options.filter((o) => String(o).trim()).length >= 2;
  if (!content && !hasPoll) return json({ error: "status content or poll is required" }, 422);

  const visibility = (body.visibility as string) ?? "public";
  if (!["public", "unlisted", "private", "direct"].includes(visibility)) {
    return json({ error: "Validation failed: Visibility can be one of public, unlisted, private, direct" }, 422);
  }
  if (pollRaw && pollRaw.expires_in != null && (!Number.isFinite(Number(pollRaw.expires_in)) || Number(pollRaw.expires_in) < 300)) {
    return json({ error: "Validation failed: expires_in must be at least 300 seconds" }, 422);
  }
  const inReplyToIdRaw = body.in_reply_to_id as string | undefined;
  const inReplyToId = inReplyToIdRaw ? decodeStatusId(inReplyToIdRaw, domain) : undefined;
  let sensitive = body.sensitive === true || body.sensitive === "true";
  let spoilerText = (body.spoiler_text as string | undefined) ?? "";
  const language = body.language as string | undefined;
  const mediaIds = (body.media_ids as string[] | undefined) ?? [];

  // ── Quote post (Mastodon 4.5 / FEP-044f) ─────────────────────────────────
  const quotedStatusIdRaw = (body.quoted_status_id as string | undefined) ?? (body.quote_id as string | undefined);
  let quoteId: string | null = null;
  let quotedAuthor: import("@/lib/types").LocalActor | null = null;
  if (quotedStatusIdRaw) {
    const quotedIri = decodeStatusId(quotedStatusIdRaw, domain);
    let quoted = await getObjectById(env.DB, quotedIri);
    if (!quoted && /^https?:\/\//i.test(quotedIri) && !quotedIri.startsWith(`https://${domain}/`)) {
      const resolved = await fetchAndCacheRemoteStatus(env.DB, quotedIri);
      if (resolved.object) quoted = resolved.object;
    }
    if (!quoted) return json({ error: "Validation failed: Quoted status not found" }, 422);
    if (quoted.visibility === "direct") {
      return json({ error: "Validation failed: Cannot quote a direct message" }, 422);
    }
    // A followers-only post may only be quoted privately (Mastodon behaviour).
    if (quoted.visibility === "followers" && visibility !== "private" && visibility !== "direct") {
      return json({ error: "Validation failed: Private posts can only be quoted privately" }, 422);
    }
    const qAuthor = await getActorById(env.DB, quoted.actorId);
    if (qAuthor) {
      quotedAuthor = qAuthor;
      const policy = (await getActorPreference(env.DB, qAuthor.id, "posting:default:quote_policy")) ?? "followers";
      if (!(await quoteAllowed(env.DB, actor, qAuthor, policy))) {
        return json({ error: "This account does not allow quoting their posts" }, 422);
      }
    }
    quoteId = quoted.id;
  }

  // If any pending media is marked sensitive, the whole status is sensitive
  // (matches Mastodon): remote instances then blur the media even without a CW.
  for (const mediaId of mediaIds.slice(0, 4)) {
    if (sensitive) break;
    const pendingRaw = await env.KV.get(`pending_media:${mediaId}`);
    if (!pendingRaw) continue;
    try {
      const pending = JSON.parse(pendingRaw) as { sensitive?: boolean };
      if (pending.sensitive === true) sensitive = true;
    } catch { /* ignore */ }
  }

  // Process content: linkify mentions, hashtags, URLs, custom emoji → HTML
  const localEmojis = await getAllCustomEmojis(env.DB);

  const scheduledAt = body.scheduled_at as string | undefined;
  if (scheduledAt) {
    const schedDate = new Date(scheduledAt);
    if (schedDate > new Date()) {
      const schedId = generateId();
      const mediaIds = (body.media_ids as string[] | undefined) ?? [];
      const normalizedScheduledAt = scheduledAt.replace("T", " ").replace(/\.\d+Z$/, "");
      await createScheduledStatus(env.DB, schedId, actor.id, normalizedScheduledAt, JSON.stringify(body), mediaIds.length > 0 ? JSON.stringify(mediaIds) : null);
      return json({
        id: schedId,
        scheduled_at: scheduledAt,
        params: body,
        media_attachments: [],
      }, 200);
    }
  }

  // ── Address conversation participants when replying ────────────────────────
  // Mastodon notifies the author of the replied-to status and everyone mentioned
  // anywhere in the thread, even when the reply names nobody: the reply is
  // addressed to them, delivered to their inboxes and they get a notification.
  // Only Mention tags are added here — the @handles themselves already live in
  // the user's text (the composer pre-fills them with their full domain), so
  // nothing is prepended to the visible content.
  const parent = inReplyToId ? await getObjectById(env.DB, inReplyToId) : null;
  const replyToAccountId = parent?.actorId ?? null;
  const parentNode: ThreadNode | null = parent
    ? parent
    : inReplyToId?.startsWith("https://")
      ? await fetchReplyParent(actor, inReplyToId)
      : null;

  let replyMentionTags: APTag[] = [];
  if (inReplyToId && parentNode) {
    // Resolve bare @username mentions against the conversation participants so
    // that @santiago typed without a domain still links to the real remote
    // account (santiago@mastodon.uy) instead of a dead local URL.
    const participants = await collectThreadParticipants(env.DB, parentNode, baseUrl);
    const localDomain = new URL(baseUrl).hostname;
    content = expandBareMentions(content ?? "", participants, localDomain);

    // Which actors are already mentioned in the user's own text (avoid dupes)
    const { tags: userMentionTags } = processStatusContent(content ?? "", baseUrl, localEmojis);
    const alreadyMentioned = new Set<string>();
    for (const tag of userMentionTags) {
      const key = mentionKey(tag);
      if (key) alreadyMentioned.add(key);
    }
    const mentions = await buildReplyMentions(env.DB, parentNode, baseUrl, actor.id, alreadyMentioned);
    replyMentionTags = mentions.tags;
  }

  const { html: htmlContent, tags: contentTags } = processStatusContent(content ?? "", baseUrl, localEmojis);

  // Merge tag-only mention additions and de-duplicate Mention tags by actor
  const seenMentionKeys = new Set<string>();
  const allTags: APTag[] = [];
  for (const tag of [...contentTags, ...replyMentionTags]) {
    if (tag.type === "Mention" && tag.href) {
      const key = mentionKey(tag);
      if (key && seenMentionKeys.has(key)) continue;
      if (key) seenMentionKeys.add(key);
    }
    allTags.push(tag);
  }

  // ── AI Guardian: pre-publish content gate ─────────────────────────────────
  // Fast Llama Guard screen on every status with text; flagged content is
  // evaluated by the reasoning model. Clearly harmful posts are blocked before
  // they are published or delivered; borderline adult content is auto-marked
  // sensitive. When the AI is unavailable the post proceeds and the scheduled
  // moderation cycle reviews it later.
  if (env.AI && (content ?? "").trim()) {
    const accountAgeMs = Date.now() - new Date(actor.createdAt).getTime();
    const gate = await screenStatus(env, {
      contentHtml: htmlContent,
      spoilerText,
      mediaCount: mediaIds.length,
      isReply: Boolean(inReplyToId),
      visibility,
      authorId: actor.id,
      authorUsername: actor.username,
      accountAgeDays: Number.isFinite(accountAgeMs) ? Math.max(0, accountAgeMs / 86400000) : 0,
      statusesCount: actor.statusesCount,
      objectId: null,
    });

    if (gate.blocked) {
      return json({ error: "This content was blocked because it violates the community guidelines." }, 422);
    }
    if (gate.markedSensitive) {
      sensitive = true;
      spoilerText = spoilerText || "Contenido sensible";
    }
  }

  // Address the conversation participants in to/cc (Mastodon TagManager logic:
  // mentions go to `cc` except for direct messages, where they are the `to`).
  const mentionedIRIs = allTags
    .filter((t) => t.type === "Mention" && t.href && t.href !== actor.id)
    .map((t) => t.href!);
  const followersAudience = followersIRI(baseUrl, actor.username);
  let noteTo: string[];
  let noteCc: string[];
  if (visibility === "public") {
    noteTo = [PUBLIC_ADDRESS];
    noteCc = [followersAudience, ...mentionedIRIs];
  } else if (visibility === "unlisted") {
    noteTo = [followersAudience];
    noteCc = [PUBLIC_ADDRESS, ...mentionedIRIs];
  } else if (visibility === "followers") {
    noteTo = [followersAudience];
    noteCc = [...mentionedIRIs];
  } else {
    // direct
    noteTo = [...mentionedIRIs];
    noteCc = [];
  }

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
    tags: allTags,
    to: noteTo,
    cc: noteCc,
  });
  // note.attachment will be set after linkedAttachments is populated below

  // FEP-044f: federate the quoted post so remote instances can render it.
  if (quoteId) {
    (note as Record<string, unknown>).quote = quoteId;
  }

  await createObject(env.DB, {
    id: note.id,
    type: "Note",
    actorId: actor.id,
    content: htmlContent,
    contentWarning: sensitive ? spoilerText : null,
    sensitive,
    visibility: visibility as "public" | "unlisted" | "followers" | "direct",
    inReplyToId: inReplyToId ?? null,
    quoteId,
    language: language ?? null,
    url: note.url ?? note.id,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published,
    local: true,
    raw: JSON.stringify(note),
  });

  // Direct messages become conversations for every local participant. The
  // sender gets a read copy; each local recipient gets an unread one.
  if (visibility === "direct") {
    const localRecipientIds: string[] = [];
    for (const iri of mentionedIRIs) {
      if (!iri.startsWith(baseUrl + "/")) continue;
      const m = iri.match(/\/users\/([a-zA-Z0-9_]+)$/);
      if (!m) continue;
      const mentioned = await getActorByUsername(env.DB, m[1], domain);
      if (mentioned?.isLocal && mentioned.id !== actor.id) localRecipientIds.push(mentioned.id);
    }
    await upsertDirectConversation(env.DB, actor.id, mentionedIRIs, note.id, false);
    for (const rid of localRecipientIds) {
      await upsertDirectConversation(env.DB, rid, [actor.id], note.id, true);
    }
  }

  // Store idempotency mapping so a retried submission returns the same status.
  if (idempotencyKey) {
    await env.KV.put(`idempotency:${actor.id}:${idempotencyKey}`, note.id, { expirationTtl: 3600 });
  }

  // Link any pending media attachments
  const linkedAttachments = [];
  for (const mediaId of mediaIds.slice(0, 4)) {
    const pendingRaw = await env.KV.get(`pending_media:${mediaId}`);
    if (!pendingRaw) continue;
    try {
      const pending = JSON.parse(pendingRaw) as Record<string, unknown>;
      // A CW/sensitive status blurs its media by default.
      const mediaSensitive = sensitive || pending.sensitive === true;
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
        sensitive: mediaSensitive,
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
  }

  // Create notifications for mentioned local users. The parent author is always
  // auto-mentioned on replies (see above), so this also covers the "reply
  // without naming anyone" case. Notifications are de-duplicated per recipient.
  const notified = new Set<string>();
  if (inReplyToId && parent?.actorId && parent.actorId !== actor.id) {
    const parentOwner = await getActorById(env.DB, parent.actorId);
    if (parentOwner?.isLocal) notified.add(parentOwner.id);
  }
  for (const tag of allTags) {
    if (tag.type !== "Mention" || !tag.href || tag.href === actor.id || !tag.href.startsWith(baseUrl)) continue;
    const usernameMatch = tag.href.match(/\/users\/([a-zA-Z0-9_]+)$/);
    if (!usernameMatch) continue;
    const mentioned = await getActorByUsername(env.DB, usernameMatch[1], domain);
    if (mentioned?.isLocal && mentioned.id !== actor.id && !notified.has(mentioned.id)) {
      notified.add(mentioned.id);
      await notify(env, {
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

  // Notify the author of the quoted status (Mastodon sends a `quote` notification).
  if (quoteId && quotedAuthor?.isLocal && quotedAuthor.id !== actor.id && !notified.has(quotedAuthor.id)) {
    notified.add(quotedAuthor.id);
    await notify(env, {
      id: generateId(),
      type: "quote",
      accountId: actor.id,
      targetAccountId: quotedAuthor.id,
      objectId: note.id,
      read: false,
      createdAt: published,
    });
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
  const createActivity = buildCreate(baseUrl, actor.id, note, generateId());
  const fetchActor = async (id: string): Promise<APActor | null> => {
    const cached = await getActorById(env.DB, id);
    if (cached) return cached as unknown as APActor;
    const remote = await fetchRemoteObject(id, `${actor.id}#main-key`, actor.privateKeyPem!);
    return remote as APActor | null;
  };

  // Inboxes of every remote account mentioned in the status. This includes the
  // auto-mentioned conversation participants (replied-to author + thread), so a
  // reply always reaches the people it answers, even if they don't follow us.
  // Local accounts are notified directly and never delivered to our own inbox.
  const mentionIRIs = allTags
    .filter((t) => t.type === "Mention" && t.href)
    .map((t) => t.href!)
    .filter((href) => href !== actor.id && !isLocalIRI(href, domain));
  const mentionInboxes = await collectFollowerInboxes(mentionIRIs, fetchActor);

  // Quote delivery: the quoted post's author must receive the Create activity
  // so their instance can raise a `quote` notification (Mastodon behaviour).
  let quoteAuthorInboxes: string[] = [];
  if (quoteId && quotedAuthor && !quotedAuthor.isLocal && quotedAuthor.id !== actor.id) {
    quoteAuthorInboxes = await collectFollowerInboxes([quotedAuthor.id], fetchActor);
  }

  if (visibility === "direct") {
    // Direct replies are delivered only to the addressed accounts
    const targets = [...mentionInboxes, ...quoteAuthorInboxes];
    if (targets.length > 0) {
      await enqueueDeliveries(env.DELIVERY_QUEUE, targets, JSON.stringify(createActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
    }
  } else {
    // Get IDs of actors who follow the current user (actor_id = follower, target_id = followed)
    const followers = await env.DB
      .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
      .bind(actor.id)
      .all<{ actor_id: string }>();

    const followerIds = followers.results.map((r) => r.actor_id);
    const inboxes = await collectFollowerInboxes(followerIds, fetchActor);
    inboxes.push(...mentionInboxes, ...quoteAuthorInboxes);
    if (inboxes.length > 0) {
      // Use queue for reliable delivery with automatic retries
      await enqueueDeliveries(env.DELIVERY_QUEUE, inboxes, JSON.stringify(createActivity), actor.id, `${actor.id}#main-key`, actor.privateKeyPem);
    }
  }

  const serializedQuote = quoteId ? await serializeQuote(env.DB, await getObjectById(env.DB, quoteId), domain) : null;
  const serializedStatus = serializeStatus(
    { id: note.id, type: "Note", actorId: actor.id, content: htmlContent, contentWarning: sensitive ? spoilerText : null, sensitive, visibility: visibility as "public", inReplyToId: inReplyToId ?? null, quoteId, language: language ?? null, url: note.id, repliesCount: 0, reblogsCount: 0, favouritesCount: 0, published, updatedAt: published, local: true, raw: JSON.stringify(note) },
    actor,
    domain,
    { attachments: linkedAttachments, poll: serializedPoll, inReplyToAccountId: replyToAccountId ?? null, quote: serializedQuote, quotesCount: 0 }
  );

  // Broadcast to streaming clients — collect tasks and await all together
  const broadcastTasks: Promise<void>[] = [];
  // Silenced/suspended local accounts are hidden from the public streams too.
  if ((visibility === "public" || visibility === "unlisted") && !actor.silenced && !actor.suspended) {
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
