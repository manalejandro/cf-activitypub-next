/**
 * Inbox activity processor — handles all incoming ActivityPub activities.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { APActivity, APNote, APActor, APAttachment, LocalAttachment } from "@/lib/types";
import type { CallSession } from "@/lib/types/call";
import {
  getActorById,
  getActorByUsername,
  getFollow,
  createFollow,
  updateFollowState,
  deleteFollow,
  getObjectById,
  createObject,
  createAttachment,
  deleteObject,
  createLike,
  deleteLike,
  createAnnounce,
  deleteAnnounce,
  createNotification,
  updateActor,
  updateObject,
  upsertRemoteActor,
  createReport,
  getPollByObjectId,
  getPollOptions,
  getPollVotesByActor,
  createPoll,
  createPollVotes,
  getAllCustomEmojis,
  getLocalInteractedActorIds,
  isActorBlockedBy,
  isInstanceDomainBlocked,
} from "@/lib/db";
import {
  buildAccept,
  buildFollow,
  generateId,
} from "./utils";
import { upsertCustomEmoji } from "@/lib/db";
import { encodeStatusId } from "@/lib/mastodon/statusId";
import { deliverToInbox, fetchRemoteObject } from "./federation";
import { fetchAndCacheRemoteActor } from "./remote";
import { evaluateReportWithAI } from "@/lib/moderation/reportAI";
import { broadcastNotificationEvent, broadcastPublicStatus, broadcastHomeStatus, broadcastCallEvent, broadcastObjectDelete } from "@/lib/streaming/broadcast";
import { deliverPushSafe } from "@/lib/push";
import type { LocalNotification } from "@/lib/types";
import { serializeStatus, serializePoll, serializeNotification } from "@/lib/mastodon/serializers";
import { serializeQuote } from "@/lib/mastodon/quote";
import { sanitizeRemoteNoteContent, sanitizeRemoteActorSummary, sanitizeFediversePlain } from "./sanitize";
import { apAttachmentType } from "./content";
import { extractQuoteId } from "./utils";
import { isContentObjectType, mlsObjectTypeFromType } from "./vocab";
import { storePublicMlsEnvelope } from "./mlsEnvelope";
import {
  getMlsKeyPackageByObjectId,
  upsertMlsKeyPackage,
  setMlsKeyPackageActive,
  deleteMlsKeyPackageByObjectId,
  deleteMlsMessagesByObjectId,
  insertMlsMessage,
  upsertDirectConversation,
} from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DONamespace = { idFromName(name: string): any; get(id: any): { fetch(input: string | URL, init?: RequestInit): Promise<Response> } };
type KVNamespace = { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };

interface InboxContext {
  db: D1Database;
  baseUrl: string;
  /** KV namespace — used to persist call sessions for cross-instance WebRTC signaling. */
  kv?: KVNamespace | null;
  /** The local actor the activity was delivered to (null for shared inbox). */
  recipient?: { id: string; username: string; privateKeyPem: string } | null;
  /**
   * The actor that signed the HTTP request (derived from the Signature keyId).
   * Used to reject cross-actor spoofing — see processInboxActivity.
   */
  signingActorId?: string | null;
  /** A local actor key to use when making signed HTTP GET requests to remote servers. */
  signingKey?: { id: string; privateKeyPem: string } | null;
  /** DO namespace for streaming — used to push notification events to connected clients. */
  timelineStream?: DONamespace | null;
  /** VAPID keys for Web Push delivery. */
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidEmail?: string;
  /** Workers AI binding — used to run the Guardian report pipeline on inbound Flags. */
  ai?: Ai | null;
  /** Outbound email binding for report-outcome notifications. */
  email?: SendEmail | null;
  fromEmail?: string;
  instanceTitle?: string;
}

/** Helper: broadcast streaming event + deliver Web Push for a new notification. */
async function broadcastAndPush(ctx: InboxContext, notif: LocalNotification): Promise<void> {
  if (ctx.timelineStream) {
    const payload = await serializeFullNotification(ctx, notif);
    void broadcastNotificationEvent(ctx.timelineStream, notif.targetAccountId, payload).catch(() => {});
  }
  if (ctx.vapidPublicKey && ctx.vapidPrivateKey && ctx.vapidEmail) {
    void deliverPushSafe(ctx.db, ctx.vapidPublicKey, ctx.vapidPrivateKey, ctx.vapidEmail, notif);
  }
}

/**
 * Serialize a notification to its Mastodon REST shape so streaming clients
 * receive the full payload instead of "{}".
 */
async function serializeFullNotification(ctx: InboxContext, notif: LocalNotification): Promise<string> {
  try {
    const [fromActor, target, object] = await Promise.all([
      getActorById(ctx.db, notif.accountId),
      getActorById(ctx.db, notif.targetAccountId),
      notif.objectId ? getObjectById(ctx.db, notif.objectId) : Promise.resolve(null),
    ]);
    if (!fromActor) return "{}";
    const localDomain = target?.isLocal && target.domain ? target.domain : new URL(ctx.baseUrl).hostname;
    const objectAuthor = object ? await getActorById(ctx.db, object.actorId) : null;
    return JSON.stringify(serializeNotification(notif, fromActor, localDomain, object ?? undefined, objectAuthor ?? undefined));
  } catch {
    return "{}";
  }
}

export async function processInboxActivity(
  activity: APActivity,
  ctx: InboxContext
): Promise<void> {
  const type = (activity.type ?? "").toLowerCase();

  // Anti-spoofing: the HTTP-signature signer must own the activity's `actor`.
  // Mastodon (ProcessActivityService#different_actor?) only processes activities
  // whose `actor` differs from the signer when they carry a verifiable embedded
  // (Linked-Data) signature. We don't support embedded signatures, so any
  // cross-actor activity is dropped here.
  const activityActorId = typeof activity.actor === "string"
    ? activity.actor
    : (activity.actor as { id?: string } | undefined)?.id;
  if (
    ctx.signingActorId &&
    activityActorId &&
    !signerOwnsActor(ctx.signingActorId, activityActorId)
  ) {
    return;
  }

  // Reject activities from domains the instance has blocked (like Mastodon's
  // suspend-level domain block).
  const blockedActorId = ctx.signingActorId ?? activityActorId;
  if (blockedActorId) {
    try {
      const domain = new URL(blockedActorId).hostname;
      if (domain && (await isInstanceDomainBlocked(ctx.db, domain))) {
        return;
      }
    } catch { /* non-URL actor id */ }
  }

  try {
    switch (type) {
      case "create":
        await handleCreate(activity, ctx);
        break;
      case "follow":
        await handleFollow(activity, ctx);
        break;
      case "accept":
        await handleAccept(activity, ctx);
        break;
      case "reject":
        await handleReject(activity, ctx);
        break;
      case "undo":
        await handleUndo(activity, ctx);
        break;
      case "like":
        await handleLike(activity, ctx);
        break;
      case "announce":
        await handleAnnounce(activity, ctx);
        break;
      case "delete":
        await handleDelete(activity, ctx);
        break;
      case "flag":
        await handleFlag(activity, ctx);
        break;
      case "add":
        await handleAdd(activity, ctx);
        break;
      case "remove":
        await handleRemove(activity, ctx);
        break;
      case "update":
        await handleUpdate(activity, ctx);
        break;
      case "move":
        await handleMove(activity, ctx);
        break;
      case "calloffer":
        await handleCallOffer(activity, ctx);
        break;
      case "callanswer":
        await handleCallAnswer(activity, ctx);
        break;
      case "callicecandidate":
        await handleCallIceCandidate(activity, ctx);
        break;
      case "callhangup":
        await handleCallHangup(activity, ctx);
        break;
      case "callrenegotiate":
        await handleCallRenegotiate(activity, ctx);
        break;
      case "callrenegotiateanswer":
        await handleCallRenegotiateAnswer(activity, ctx);
        break;
      default:
        // Ignore unknown activity types
        break;
    }
  } catch (err) {
    const failed = activity as { type?: unknown; id?: unknown };
    console.error("[inbox] Error processing activity:", failed?.type, failed?.id, err);
  }
}

// ─────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────

/**
 * Ensure a Question object has poll rows (polls + poll_options). Idempotent.
 * Used by every ingestion path (Create, Update, Announce, Like) so voting
 * options render on timelines even when the object was stored before poll
 * rows existed (e.g. ingested via Announce/Update/Like, or a stale object).
 */
async function ensurePollRowsForQuestion(ctx: InboxContext, obj: APNote): Promise<void> {
  const rawType = Array.isArray(obj.type) ? obj.type[0] : obj.type;
  const objType = String(rawType ?? "").split("/").pop();
  if (objType !== "Question") return;
  if (await getPollByObjectId(ctx.db, obj.id)) return;

  const single = Array.isArray(obj.oneOf) ? obj.oneOf : [];
  const multi = Array.isArray(obj.anyOf) ? obj.anyOf : [];
  const choices = single.length > 0 ? single : multi;
  if (choices.length === 0) return;

  const expiresAt = obj.endTime
    ? toUtcIso(obj.endTime)
    : new Date(Date.now() + 24 * 36e5).toISOString();
  try {
    await createPoll(ctx.db, {
      id: generateId(),
      objectId: obj.id,
      expiresAt,
      multiple: multi.length > 0,
      options: choices.map((opt, i) => ({
        id: generateId(),
        title: typeof opt?.name === "string" ? opt.name : `Opción ${i + 1}`,
        position: i,
      })),
    });
  } catch {
    /* ignore */
  }
}

async function handleCreate(activity: APActivity, ctx: InboxContext): Promise<void> {
  const obj = activity.object as APNote | undefined;
  if (!obj || typeof obj !== "object") return;

  const objType = (obj.type ?? "").split("/").pop() ?? "";
  // MLS envelopes (KeyPackage, Welcome, GroupInfo, PrivateMessage, PublicMessage)
  // are handled separately — they carry ciphertext, not renderable content.
  // `type` may be an array ([“Object”, “PrivateMessage”]) or a namespaced string.
  if (mlsObjectTypeFromType(obj.type)) {
    await handleMlsCreate(activity, ctx, obj as unknown as APMlsObject);
    return;
  }
  // Ingest any content-bearing object type, not just Notes.
  if (!isContentObjectType(objType)) return;

  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;

  // ── Poll vote detection ──────────────────────────────────────────────────
  // Mastodon sends votes as Create { object: { type: "Note", name: "<option>",
  // inReplyTo: "<question-id>", content: undefined } }.
  // The `name` field is the chosen option title; there is no `content`.
  const voteName = (obj as Record<string, unknown>).name as string | undefined;
  if (voteName && obj.inReplyTo && !obj.content) {
    const pollObj = await getObjectById(ctx.db, obj.inReplyTo);
    if (pollObj?.local) {
      const pollDb = await getPollByObjectId(ctx.db, pollObj.id);
      if (pollDb) {
        const options = await getPollOptions(ctx.db, pollDb.id);
        const idx = options.findIndex(
          (o) => o.title.toLowerCase() === voteName.toLowerCase()
        );
        if (idx !== -1) {
          // Deduplicate: only count if this actor hasn't voted yet
          const existing = await getPollVotesByActor(ctx.db, pollDb.id, actorId);
          if (existing.length === 0) {
            await createPollVotes(ctx.db, pollDb.id, actorId, [idx]);
          }
        }
      }
    }
    // Do NOT store the vote Note as a status or send notifications
    return;
  }
  // ────────────────────────────────────────────────────────────────────────

  // Ensure the remote actor is cached so we can store it as the object's author.
  // The actor may already be cached from signature verification in the route handler;
  // if not, try the inline actor object first (cheaper), then fall back to a fetch.
  // Prefer signed fetches when a local signing key is available (needed for servers
  // with authorized_fetch / Secure Mode enabled).
  const signingKey = ctx.signingKey ?? (ctx.recipient ? { id: ctx.recipient.id, privateKeyPem: ctx.recipient.privateKeyPem } : null);

  let author = await getActorById(ctx.db, actorId);
  if (!author) {
    // Use inline actor data if the sender embedded the full actor in the activity
    const inlineActor = typeof activity.actor !== "string" ? activity.actor as APActor : null;
    if (inlineActor?.publicKey?.publicKeyPem) {
      try { await upsertRemoteActor(ctx.db, inlineActor); } catch { /* ignore */ }
    } else {
      // Fall back to fetching from the network — sign the request when possible
      try {
        const fetched = await fetchRemoteObject(
          actorId,
          signingKey ? `${signingKey.id}#main-key` : undefined,
          signingKey?.privateKeyPem
        ) as APActor | null;
        if (fetched?.publicKey?.publicKeyPem) {
          await upsertRemoteActor(ctx.db, fetched);
        }
      } catch { /* ignore */ }
    }
    author = await getActorById(ctx.db, actorId);
  }
  if (!author) {
    return;
  }

  const existing = await getObjectById(ctx.db, obj.id);
  if (existing) {
    // Already stored. Backfill poll rows for Questions that were ingested via
    // other paths (Announce/Update/Like) without creating them.
    await ensurePollRowsForQuestion(ctx, obj);
    return;
  }

  const { content, contentWarning } = sanitizeRemoteNoteContent(
    obj.content,
    obj.summary,
    obj.sensitive ?? false
  );

  const visibility = resolveVisibility(obj.to, obj.cc);

  await createObject(ctx.db, {
    id: obj.id,
    type: objType,
    actorId,
    content,
    contentWarning,
    sensitive: obj.sensitive ?? false,
    visibility,
    inReplyToId: obj.inReplyTo ?? null,
    quoteId: extractQuoteId(obj as Record<string, unknown>),
    language: obj.contentMap ? Object.keys(obj.contentMap)[0] : null,
    url: resolveObjectUrl(obj.url, obj.id),
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: toUtcIso(obj.published),
    local: false,
    raw: JSON.stringify(obj),
  });

  // Direct messages create an unread conversation for the local recipient
  // and show up in the notifications column. Blocked (or domain-blocked)
  // accounts cannot send the recipient DMs.
  if (visibility === "direct" && ctx.recipient && !(await isActorBlockedBy(ctx.db, ctx.recipient.id, actorId))) {
    await upsertDirectConversation(ctx.db, ctx.recipient.id, [actorId], obj.id, true);
    const notif: LocalNotification = {
      id: generateId(),
      type: "direct",
      accountId: actorId,
      targetAccountId: ctx.recipient.id,
      objectId: obj.id,
      read: false,
      createdAt: new Date().toISOString(),
    };
    await createNotification(ctx.db, notif);
    await broadcastAndPush(ctx, notif);
  }

  // ── Federated poll ingestion ──────────────────────────────────────────────
  // Mastodon/poll servers send a Question with the choices in `oneOf` (single
  // choice) or `anyOf` (multiple choice) and the deadline in `endTime`. Without
  // creating the poll rows the status only shows the text and never the options.
  await ensurePollRowsForQuestion(ctx, obj);

  const storedAttachments: LocalAttachment[] = [];
  if (Array.isArray(obj.attachment)) {
    for (const attachment of obj.attachment as APAttachment[]) {
      if (!attachment?.url) continue;
      const localAttachment: LocalAttachment = {
        id: attachment.id || generateId(),
        objectId: obj.id,
        type: apAttachmentType(attachment.type, attachment.mediaType),
        url: attachment.url,
        remoteUrl: attachment.url,
        description: attachment.name ?? null,
        blurhash: attachment.blurhash ?? null,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
        fileSize: null,
        mimeType: attachment.mediaType ?? null,
        // A sensitive object marks its media sensitive; some servers also set
        // `sensitive` directly on the attachment.
        sensitive: obj.sensitive === true || (attachment as { sensitive?: boolean }).sensitive === true,
        createdAt: new Date().toISOString(),
      };
      try {
        await createAttachment(ctx.db, localAttachment);
        storedAttachments.push(localAttachment);
      } catch { /* ignore */ }
    }
  }

  // Process tags: mentions (notify) + emoji (cache federated emoji)
  const mentionedLocalIds = new Set<string>();
  if (Array.isArray(obj.tag)) {
    for (const tag of obj.tag as import("@/lib/types").APTag[]) {
      if (tag.type === "Mention" && tag.href) {
        // Only notify actors on this server
        if (tag.href.startsWith(ctx.baseUrl + "/")) {
          const mentionedActor = await getActorById(ctx.db, tag.href);
          if (mentionedActor?.isLocal && !mentionedLocalIds.has(mentionedActor.id)) {
            mentionedLocalIds.add(mentionedActor.id);
            const notif: LocalNotification = {
              id: generateId(),
              type: "mention",
              accountId: actorId,
              targetAccountId: mentionedActor.id,
              objectId: obj.id,
              read: false,
              createdAt: new Date().toISOString(),
            };
            await createNotification(ctx.db, notif);
            await broadcastAndPush(ctx, notif);
          }
        }
      }
      // Cache federated custom emoji
      if (tag.type === "Emoji" && tag.name && tag.icon?.url) {
        const shortcode = tag.name.replace(/^:|:$/g, "");
        if (shortcode) {
          try {
            const domain = new URL(ctx.baseUrl).hostname;
            const tagWithId = tag as import("@/lib/types").APTag & { id?: string };
            await upsertCustomEmoji(ctx.db, {
              id: tagWithId.id ?? generateId(),
              shortcode,
              url: tag.icon.url,
              staticUrl: tag.icon.url,
              domain,
              visibleInPicker: false, // federated emoji hidden from local picker
            });
          } catch {
            // Ignore duplicate or invalid emoji
          }
        }
      }
    }
  }

  // Also notify when this is a reply to a local post
  // (in case the reply author forgot to include the @mention tag)
  if (obj.inReplyTo) {
    const replyTarget = await getObjectById(ctx.db, obj.inReplyTo);
    if (replyTarget) {
      // Increment replies_count on parent (remote reply to a local post)
      if (replyTarget.actorId.startsWith(ctx.baseUrl + "/")) {
        await ctx.db
          .prepare("UPDATE objects SET replies_count = replies_count + 1 WHERE id = ?")
          .bind(obj.inReplyTo)
          .run();
      }
      if (replyTarget.actorId && !mentionedLocalIds.has(replyTarget.actorId)) {
        const targetActor = await getActorById(ctx.db, replyTarget.actorId);
        if (targetActor?.isLocal) {
          const notif: LocalNotification = {
            id: generateId(),
            type: "mention",
            accountId: actorId,
            targetAccountId: replyTarget.actorId,
            objectId: obj.id,
            read: false,
            createdAt: new Date().toISOString(),
          };
          await createNotification(ctx.db, notif);
          await broadcastAndPush(ctx, notif);
        }
      }
    }
  }

  // Broadcast to timeline streaming clients (fire-and-forget)
  if (ctx.timelineStream) {
    const statusVisibility = resolveVisibility(obj.to, obj.cc);
    // Silenced (limited) and suspended authors are hidden from the public
    // streams, but their followers still receive posts on their home feeds.
    const authorVisibleOnPublic = !author.silenced && !author.suspended;
    if (statusVisibility === "public" || statusVisibility === "unlisted") {
      const domain = new URL(ctx.baseUrl).hostname;
      const published = toUtcIso(obj.published);
      const allEmojis = await getAllCustomEmojis(ctx.db);
      let poll: import("@/lib/types").MastodonPoll | null = null;
      if (objType === "Question") {
        const pollDb = await getPollByObjectId(ctx.db, obj.id);
        if (pollDb) {
          poll = serializePoll(pollDb, await getPollOptions(ctx.db, pollDb.id), false, []);
        }
      }
      const quoteIdHere = extractQuoteId(obj as Record<string, unknown>);
      const serializedQuoteHere = quoteIdHere
        ? await getObjectById(ctx.db, quoteIdHere).then((q) => (q ? serializeQuote(ctx.db, q, domain) : null)).catch(() => null)
        : null;
      const serializedStatus = serializeStatus(
        {
          id: obj.id, type: objType, actorId, content,
          contentWarning, sensitive: obj.sensitive ?? false, visibility: statusVisibility,
          inReplyToId: obj.inReplyTo ?? null,
          quoteId: quoteIdHere,
          language: obj.contentMap ? Object.keys(obj.contentMap)[0] : null,
          url: resolveObjectUrl(obj.url, obj.id), repliesCount: 0, reblogsCount: 0, favouritesCount: 0,
          published, updatedAt: published, local: false, raw: JSON.stringify(obj),
        },
        author,
        domain,
        { attachments: storedAttachments, emojis: allEmojis, poll, quote: serializedQuoteHere, quotesCount: 0 }
      );
      const broadcastTasks: Promise<void>[] = [];
      if (authorVisibleOnPublic) {
        broadcastTasks.push(broadcastPublicStatus(ctx.timelineStream, serializedStatus, false));
      }

      // Broadcast to home feeds of local followers
      try {
        const localFollowers = await ctx.db
          .prepare("SELECT a.id FROM actors a JOIN follows f ON f.actor_id = a.id WHERE f.target_id = ? AND f.state = 'accepted' AND a.is_local = 1")
          .bind(actorId)
          .all<{ id: string }>();
        for (const row of localFollowers.results) {
          broadcastTasks.push(broadcastHomeStatus(ctx.timelineStream, row.id, serializedStatus));
        }
      } catch { /* ignore */ }

      await Promise.allSettled(broadcastTasks);
    }
  }
}

async function handleFollow(activity: APActivity, ctx: InboxContext): Promise<void> {
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const targetId = typeof activity.object === "string" ? activity.object : (activity.object as APActor)?.id;

  if (!targetId) return;

  // Follows may arrive via the shared inbox (ctx.recipient is null). Resolve the
  // local recipient from activity.object, mirroring Mastodon's behavior.
  let recipientInfo = ctx.recipient;
  if (!recipientInfo) {
    const targetActor = await getActorById(ctx.db, targetId);
    if (!targetActor?.isLocal || !targetActor.privateKeyPem) return;
    recipientInfo = { id: targetActor.id, username: targetActor.username, privateKeyPem: targetActor.privateKeyPem };
  }

  if (targetId !== recipientInfo.id) return;

  const recipient = await getActorById(ctx.db, recipientInfo.id);
  if (!recipient) return;

  // A blocked (or domain-blocked) account cannot follow the recipient.
  if (await isActorBlockedBy(ctx.db, recipientInfo.id, actorId)) return;

  // Ensure the remote follower actor is in the DB before writing FK rows
  const followerActor = await ensureActorCached(ctx.db, actorId);
  if (!followerActor) return;

  const existing = await getFollow(ctx.db, actorId, targetId);
  if (!existing) {
    await createFollow(ctx.db, {
      id: generateId(),
      actorId,
      targetId,
      state: recipient.manuallyApprovesFollowers ? "pending" : "accepted",
      activityId: activity.id,
      createdAt: new Date().toISOString(),
    });
  }

  if (!recipient.manuallyApprovesFollowers) {
    // Auto-accept: send Accept activity back to the remote server.
    // This is safe to resend even for an already-existing follow (idempotent on remote side).
    const acceptId = generateId();
    const acceptActivity = buildAccept(ctx.baseUrl, recipientInfo.id, activity, acceptId);

    // Only update counts and create notification for brand-new follows.
    if (!existing) {
      // Atomic increment — avoids lost updates under concurrent deliveries.
      await ctx.db
        .prepare("UPDATE actors SET followers_count = COALESCE(followers_count, 0) + 1 WHERE id = ?")
        .bind(recipientInfo.id)
        .run();
      const notif: LocalNotification = {
        id: generateId(),
        type: "follow",
        accountId: actorId,
        targetAccountId: recipientInfo.id,
        objectId: null,
        read: false,
        createdAt: new Date().toISOString(),
      };
      await createNotification(ctx.db, notif);
      await broadcastAndPush(ctx, notif);
    }

    // Deliver Accept to requester
    // The actor is already cached from ensureActorCached above — just read inbox.
    // Fall back to <actorId>/inbox if the DB column is somehow null.
    const requesterInbox = followerActor.inbox ??
      (followerActor.id ? `${followerActor.id.replace(/\/$/, "")}/inbox` : null);
    if (requesterInbox) {
      await deliverToInbox(
        requesterInbox,
        acceptActivity,
        `${recipientInfo.id}#main-key`,
        recipientInfo.privateKeyPem
      );
    }
  } else if (!existing) {
    const notif: LocalNotification = {
      id: generateId(),
      type: "follow_request",
      accountId: actorId,
      targetAccountId: recipientInfo.id,
      objectId: null,
      read: false,
      createdAt: new Date().toISOString(),
    };
    await createNotification(ctx.db, notif);
    await broadcastAndPush(ctx, notif);
  }
}

async function handleAccept(activity: APActivity, ctx: InboxContext): Promise<void> {
  const obj = activity.object as APActivity | undefined;
  if (!obj) return;

  const followActivityId = typeof obj === "string" ? obj : obj.id;
  // find the follow by activityId
  const rows = await ctx.db
    .prepare("SELECT * FROM follows WHERE activity_id = ?")
    .bind(followActivityId)
    .first<{ id: string; target_id: string; actor_id: string; state: string }>();

  if (rows) {
    const wasPending = rows.state === "pending";
    await updateFollowState(ctx.db, rows.id, "accepted");
    // Only update counts if the follow was pending (not already accepted optimistically)
    if (wasPending) {
      const follower = await getActorById(ctx.db, rows.actor_id);
      if (follower?.isLocal) {
        await ctx.db
          .prepare("UPDATE actors SET following_count = COALESCE(following_count, 0) + 1 WHERE id = ?")
          .bind(rows.actor_id)
          .run();
      }
      await ctx.db
        .prepare("UPDATE actors SET followers_count = COALESCE(followers_count, 0) + 1 WHERE id = ?")
        .bind(rows.target_id)
        .run();
    }
  }
}

async function handleReject(activity: APActivity, ctx: InboxContext): Promise<void> {
  const obj = activity.object as APActivity | undefined;
  if (!obj) return;

  const followActivityId = typeof obj === "string" ? obj : obj.id;
  const rows = await ctx.db
    .prepare("SELECT * FROM follows WHERE activity_id = ?")
    .bind(followActivityId)
    .first<{ id: string }>();

  if (rows) {
    await updateFollowState(ctx.db, rows.id, "rejected");
  }
}

async function handleUndo(activity: APActivity, ctx: InboxContext): Promise<void> {
  const obj = activity.object as APActivity | undefined;
  if (!obj || typeof obj !== "object") return;

  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const innerType = (obj.type ?? "").toLowerCase();

  if (innerType === "follow") {
    const targetId = typeof obj.object === "string" ? obj.object : (obj.object as APActor)?.id;
    if (targetId) {
      const deleted = await deleteFollow(ctx.db, actorId, targetId);
      // Only decrement when a follow row was actually removed, so a malicious
      // or duplicate Undo(Follow) can't drive the counter below reality.
      if (deleted) {
        await ctx.db
          .prepare("UPDATE actors SET followers_count = MAX(COALESCE(followers_count, 0) - 1, 0) WHERE id = ?")
          .bind(targetId)
          .run();
      }
    }
  } else if (innerType === "like") {
    const objectId = typeof obj.object === "string" ? obj.object : (obj.object as APNote)?.id;
    if (objectId) await deleteLike(ctx.db, actorId, objectId);
  } else if (innerType === "announce") {
    const objectId = typeof obj.object === "string" ? obj.object : (obj.object as APNote)?.id;
    if (objectId) await deleteAnnounce(ctx.db, actorId, objectId);
  }
}

/** Handle an inbound Move activity (remote account migrated to a new account). */
async function handleMove(activity: APActivity, ctx: InboxContext): Promise<void> {
  const sourceId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const targetId = typeof activity.object === "string" ? activity.object : (activity.object as APActor)?.id;
  if (!targetId) return;

  // The source account must be the one moving away. Only handle moves of
  // remote accounts — local accounts never issue Move to our own inbox.
  const source = await getActorById(ctx.db, sourceId);
  if (!source || source.isLocal) return;

  // Ensure the target account is cached so we can verify the alias and update follows.
  const target = await ensureActorCached(ctx.db, targetId);
  if (!target) return;

  // Verify the alias: the target must declare the source in its alsoKnownAs
  // (Mastodon's AccountMigrationService check). Without a verifiable alias the
  // Move is dropped — this prevents hijacking follows of unrelated accounts.
  const aliases = target.alsoKnownAs ?? [];
  if (!aliases.includes(sourceId)) {
    // Some servers only set alsoKnownAs on the target after a fresh fetch.
    const refreshed = await fetchAndCacheRemoteActor(ctx.db, targetId);
    if (refreshed) {
      const refetched = await getActorById(ctx.db, targetId);
      if (!refetched?.alsoKnownAs?.includes(sourceId)) return;
    } else {
      return;
    }
  }

  // Record the move on the source account (clients show a "moved" notice).
  await updateActor(ctx.db, sourceId, { movedTo: targetId });

  // Re-point every accepted local follow from the old account to the new one.
  const followerRows = await ctx.db
    .prepare("SELECT actor_id FROM follows WHERE target_id = ? AND state = 'accepted'")
    .bind(sourceId)
    .all<{ actor_id: string }>();

  const signingKey = ctx.signingKey ??
    (ctx.recipient ? { id: ctx.recipient.id, privateKeyPem: ctx.recipient.privateKeyPem } : null);

  let migratedCount = 0;
  for (const row of followerRows.results) {
    const followerId = row.actor_id;
    const follower = await getActorById(ctx.db, followerId);
    if (!follower?.isLocal) continue;

    // If the follower already follows the target, just drop the old follow.
    const existingTarget = await getFollow(ctx.db, followerId, targetId);
    await deleteFollow(ctx.db, followerId, sourceId);
    migratedCount++;

    if (!existingTarget) {
      await createFollow(ctx.db, {
        id: generateId(),
        actorId: followerId,
        targetId,
        state: target.manuallyApprovesFollowers ? "pending" : "accepted",
        activityId: null,
        createdAt: new Date().toISOString(),
      });
      // Notify the new account so it registers the follower.
      if (!target.manuallyApprovesFollowers && target.inbox && signingKey?.privateKeyPem) {
        const followActivity = buildFollow(ctx.baseUrl, followerId, targetId, generateId());
        await deliverToInbox(target.inbox, followActivity, signingKey.id, signingKey.privateKeyPem).catch(() => {});
      }
    }
  }

  // Adjust follower counts: decrement source by migrated, bump target by same.
  if (migratedCount > 0) {
    await ctx.db
      .prepare("UPDATE actors SET followers_count = MAX(COALESCE(followers_count, 0) - ?, 0) WHERE id = ?")
      .bind(migratedCount, sourceId)
      .run();
    await ctx.db
      .prepare("UPDATE actors SET followers_count = COALESCE(followers_count, 0) + ? WHERE id = ?")
      .bind(migratedCount, targetId)
      .run();
  }
}

async function handleLike(activity: APActivity, ctx: InboxContext): Promise<void> {
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  let objectId = typeof activity.object === "string" ? activity.object : (activity.object as APNote)?.id;
  if (!objectId) return;

  // Ensure actor is in DB (FK on likes.actor_id)
  const likerActor = await ensureActorCached(ctx.db, actorId);
  if (!likerActor) return;

  // Resolve the liked object:
  //   1. Look up by ActivityPub id
  //   2. If not found, fall back to objects.url (some servers send the url
  //      instead of the AP id in the Like object field)
  //   3. If still not found and it's a remote object, try to fetch and store it
  let likedObject = await getObjectById(ctx.db, objectId);
  if (!likedObject) {
    const urlRow = await ctx.db
      .prepare("SELECT id FROM objects WHERE url = ?")
      .bind(objectId)
      .first<{ id: string }>();
    if (urlRow) {
      objectId = urlRow.id;
      likedObject = await getObjectById(ctx.db, objectId);
    }
  }
  if (!likedObject && objectId.startsWith("https://")) {
    try {
      const signingKey = ctx.signingKey ?? (ctx.recipient ? { id: ctx.recipient.id, privateKeyPem: ctx.recipient.privateKeyPem } : null);
      let fetched = await fetchRemoteObject(
        objectId,
        signingKey ? `${signingKey.id}#main-key` : undefined,
        signingKey?.privateKeyPem
      ) as APNote | null;
      // Retry without auth if signed fetch failed (some servers don't require it)
      if (!fetched) {
        fetched = await fetchRemoteObject(objectId) as APNote | null;
      }
      if (fetched?.id) {
        if (isContentObjectType((fetched.type ?? "Note") as string)) {
          const noteActorId = typeof fetched.attributedTo === "string"
            ? fetched.attributedTo
            : (fetched.attributedTo as APActor | undefined)?.id;
          if (noteActorId) await ensureActorCached(ctx.db, noteActorId);
          const { content, contentWarning } = sanitizeRemoteNoteContent(
            fetched.content,
            fetched.summary,
            fetched.sensitive ?? false
          );
          await createObject(ctx.db, {
            id: fetched.id,
            type: (fetched.type ?? "Note") as string,
            actorId: noteActorId ?? actorId,
            content,
            contentWarning,
            sensitive: fetched.sensitive ?? false,
            visibility: resolveVisibility(fetched.to, fetched.cc),
            inReplyToId: fetched.inReplyTo ?? null,
            quoteId: extractQuoteId(fetched as Record<string, unknown>),
            language: fetched.contentMap ? Object.keys(fetched.contentMap)[0] : null,
            url: resolveObjectUrl(fetched.url, fetched.id),
            repliesCount: 0,
            reblogsCount: 0,
            favouritesCount: 0,
            published: toUtcIso(fetched.published),
            local: false,
            raw: JSON.stringify(fetched),
          });
          await saveObjectAttachments(ctx.db, fetched.id, fetched.attachment, fetched.sensitive === true);
          await ensurePollRowsForQuestion(ctx, fetched);
          likedObject = await getObjectById(ctx.db, objectId);
        }
      }
    } catch {
      // ignore
    }
  }

  if (!likedObject) {
    return;
  }

  const existing = await ctx.db
    .prepare("SELECT id FROM likes WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .first();

  if (!existing) {
    await createLike(ctx.db, {
      id: generateId(),
      actorId,
      objectId,
      activityId: activity.id,
      createdAt: new Date().toISOString(),
    });

    const owner = await getActorById(ctx.db, likedObject.actorId);
    if (owner?.isLocal) {
      const notif: LocalNotification = {
        id: generateId(),
        type: "favourite",
        accountId: actorId,
        targetAccountId: likedObject.actorId,
        objectId,
        read: false,
        createdAt: new Date().toISOString(),
      };
      await createNotification(ctx.db, notif);
      await broadcastAndPush(ctx, notif);
    }
  }
}

// Persist a remote note-like object (used for boosted posts). Prefers the
// content embedded in the incoming activity and only falls back to a network
// fetch when the embedded object is missing or has no usable content.
async function persistRemoteNote(
  ctx: InboxContext,
  note: APNote,
  fallbackActorId: string
): Promise<void> {
  const noteActorId = typeof note.attributedTo === "string"
    ? note.attributedTo
    : (note.attributedTo as APActor | undefined)?.id;
  if (noteActorId) await ensureActorCached(ctx.db, noteActorId);
  const { content, contentWarning } = sanitizeRemoteNoteContent(
    note.content,
    note.summary,
    note.sensitive ?? false
  );

  const existing = await getObjectById(ctx.db, note.id);
  if (existing) {
    // Object already present but may have empty content (e.g. saved earlier
    // before the embedded content was used). Fill it in from the activity.
    if (!existing.content && content) {
      await updateObject(ctx.db, note.id, {
        content,
        contentWarning,
        sensitive: note.sensitive ?? false,
        raw: JSON.stringify(note),
      });
    }
    await saveObjectAttachments(ctx.db, note.id, note.attachment, note.sensitive === true);
    return;
  }

  await createObject(ctx.db, {
    id: note.id,
    type: note.type ?? "Note",
    actorId: noteActorId ?? fallbackActorId,
    content,
    contentWarning,
    sensitive: note.sensitive ?? false,
    visibility: resolveVisibility(note.to, note.cc),
    inReplyToId: note.inReplyTo ?? null,
    quoteId: extractQuoteId(note as Record<string, unknown>),
    language: note.contentMap ? Object.keys(note.contentMap)[0] : null,
    url: resolveObjectUrl(note.url, note.id),
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: toUtcIso(note.published),
    local: false,
    raw: JSON.stringify(note),
  });
  await saveObjectAttachments(ctx.db, note.id, note.attachment, note.sensitive === true);
  await ensurePollRowsForQuestion(ctx, note);
}

async function handleAnnounce(activity: APActivity, ctx: InboxContext): Promise<void> {
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const rawObject = activity.object;
  const objectId = typeof rawObject === "string" ? rawObject : (rawObject as APNote)?.id;
  if (!objectId) return;

  // Ensure actor is in DB (FK on announces.actor_id)
  const announcerActor = await ensureActorCached(ctx.db, actorId);
  if (!announcerActor) return;

  const embedded = typeof rawObject === "object" && rawObject !== null ? rawObject as APNote : null;

  // If the boosted post is not yet stored locally, save it so it appears in the
  // federated timeline regardless of whether we follow the author. Mastodon
  // always embeds the full note in the Announce, so prefer that content instead
  // of a network fetch (which may fail or return a content-less Note on servers
  // with authorized_fetch / Secure Mode).
  const knownObj = await getObjectById(ctx.db, objectId);
  const needsStore = !knownObj || !knownObj.content;
  if (needsStore && objectId.startsWith("https://")) {
    try {
      let toStore: APNote | null = null;
      const embeddedHasContent = embedded
        && isContentObjectType((embedded.type ?? "").split("/").pop() ?? "")
        && ((embedded as APNote).content || (embedded as APNote).attachment?.length);
      if (embeddedHasContent) {
        toStore = embedded;
      } else {
        const signingKey = ctx.signingKey ?? (ctx.recipient ? { id: ctx.recipient.id, privateKeyPem: ctx.recipient.privateKeyPem } : null);
        let fetched = await fetchRemoteObject(
          objectId,
          signingKey ? `${signingKey.id}#main-key` : undefined,
          signingKey?.privateKeyPem
        ) as APNote | null;
        // Retry without auth if signed fetch failed (some servers don't require it)
        if (!fetched) {
          fetched = await fetchRemoteObject(objectId) as APNote | null;
        }
        if (fetched && isContentObjectType((fetched as APNote).type as string)) {
          toStore = fetched;
        }
      }
      if (toStore) {
        await persistRemoteNote(ctx, toStore, actorId);
      }
    } catch {
      // ignore
    }
  }

  // If the boosted object still isn't in the DB after the fetch attempt, we
  // cannot create the announce — the FK on announces.object_id would fail.
  const resolvedObj = await getObjectById(ctx.db, objectId);
  if (!resolvedObj) {
    return;
  }

  const existing = await ctx.db
    .prepare("SELECT id FROM announces WHERE actor_id = ? AND object_id = ?")
    .bind(actorId, objectId)
    .first();

  if (!existing) {
    await createAnnounce(ctx.db, {
      id: generateId(),
      actorId,
      objectId,
      activityId: activity.id,
      createdAt: new Date().toISOString(),
    });

    const owner = await getActorById(ctx.db, resolvedObj.actorId);
    if (owner?.isLocal) {
      const notif: LocalNotification = {
        id: generateId(),
        type: "reblog",
        accountId: actorId,
        targetAccountId: resolvedObj.actorId,
        objectId,
        read: false,
        createdAt: new Date().toISOString(),
      };
      await createNotification(ctx.db, notif);
      await broadcastAndPush(ctx, notif);
    }
  }
}

async function handleDelete(activity: APActivity, ctx: InboxContext): Promise<void> {
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const objectId = typeof activity.object === "string"
    ? activity.object
    : (activity.object as { id: string })?.id;
  if (!objectId) return;

  // MLS: delete a KeyPackage or a delivered message envelope.
  const kp = await getMlsKeyPackageByObjectId(ctx.db, objectId);
  if (kp && kp.actorId === actorId) {
    await deleteMlsKeyPackageByObjectId(ctx.db, objectId);
  }
  if (await mlsObjectExists(ctx, objectId)) {
    await deleteMlsMessagesByObjectId(ctx.db, objectId);
    await routeMlsLifecycle(activity, ctx, objectId, null);
    return;
  }

  const obj = await getObjectById(ctx.db, objectId);
  if (obj && obj.actorId === actorId) {
    await deleteObject(ctx.db, objectId);

    // Remove the status from connected clients' timelines live (no reload
    // needed): federated/local/remote feeds, local followers' home feeds,
    // hashtag timelines and list timelines, mirroring the local delete route.
    if (ctx.timelineStream) {
      await broadcastObjectDelete(ctx.timelineStream, ctx.db, obj);
    }
  }
}

/**
 * Handle an inbound federated report (ActivityPub Flag), Mastodon-compatible.
 *
 * Mastodon serializes a Flag with `object` as an ARRAY of URIs: first the
 * reported account, then each reported status (ActivityPub::FlagSerializer).
 * It may also be a bare string URI. Like Mastodon's ActivityPub::Activity::Flag,
 * each distinct target account in the URIs produces its own report, and the
 * statuses are attached to the report of the account that authored them.
 * Reported statuses are cached so our admins can review the full evidence.
 * No automatic action is taken — federated reports queue for local moderators.
 */
async function handleFlag(activity: APActivity, ctx: InboxContext): Promise<void> {
  const reporterId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  if (!reporterId) return;

  // Make sure the reporter (remote account) is cached.
  let reporter = await getActorById(ctx.db, reporterId);
  if (!reporter) {
    const inlineActor = typeof activity.actor !== "string" ? activity.actor as APActor : null;
    if (inlineActor?.publicKey?.publicKeyPem) {
      try { await upsertRemoteActor(ctx.db, inlineActor); } catch { /* ignore */ }
    } else {
      try {
        const fetched = await fetchRemoteObject(reporterId) as APActor | null;
        if (fetched?.publicKey?.publicKeyPem) await upsertRemoteActor(ctx.db, fetched);
      } catch { /* ignore */ }
    }
    reporter = await getActorById(ctx.db, reporterId);
  }
  if (!reporter) return;

  // `object` is an array of URIs ([targetAccount, ...statusUris]) or a single
  // string URI — coerce to an array. Embedded objects are reduced to their id.
  const rawObject = activity.object;
  const objectUris: string[] = Array.isArray(rawObject)
    ? rawObject.map((o) => (typeof o === "string" ? o : (o as { id?: string })?.id)).filter((v): v is string => !!v)
    : (typeof rawObject === "string" ? [rawObject] : (rawObject as { id?: string })?.id ? [(rawObject as { id?: string }).id as string] : []);
  if (objectUris.length === 0) return;

  // Resolve each URI to either a target account or an evidence status.
  // Statuses are grouped by their author so each account gets its own report,
  // mirroring Mastodon's flag.rb. Unknown statuses are fetched and cached.
  const targets = new Map<string, { id: string; statusUris: string[] }>();
  const seenStatuses = new Set<string>();

  for (const uri of objectUris) {
    if (uri === reporterId) continue;

    // Is it a known account (a report target)?
    const actor = await getActorById(ctx.db, uri);
    if (actor) {
      if (!targets.has(actor.id)) targets.set(actor.id, { id: actor.id, statusUris: [] });
      continue;
    }

    // Is it a known object (a reported status)?
    const existing = await getObjectById(ctx.db, uri);
    if (existing) {
      const ownerId = existing.actorId;
      if (!targets.has(ownerId)) targets.set(ownerId, { id: ownerId, statusUris: [] });
      if (!seenStatuses.has(uri)) {
        seenStatuses.add(uri);
        targets.get(ownerId)!.statusUris.push(uri);
      }
      continue;
    }

    // Unknown URI — try to fetch the remote object so the evidence is cached.
    try {
      const fetched = await fetchRemoteObject(uri) as APNote | null;
      if (fetched?.id) {
        const { content, contentWarning } = sanitizeRemoteNoteContent(
          fetched.content,
          fetched.summary,
          fetched.sensitive ?? false
        );
        const visibility = resolveVisibility(fetched.to, fetched.cc);
        await createObject(ctx.db, {
          id: fetched.id,
          type: String(fetched.type ?? "Note").split("/").pop() || "Note",
          actorId: fetched.attributedTo && typeof fetched.attributedTo === "string"
            ? fetched.attributedTo
            : (fetched.attributedTo as { id?: string })?.id ?? "",
          content,
          contentWarning,
          sensitive: fetched.sensitive ?? false,
          visibility,
          inReplyToId: fetched.inReplyTo ?? null,
          quoteId: extractQuoteId(fetched as Record<string, unknown>),
          language: fetched.contentMap ? Object.keys(fetched.contentMap)[0] : null,
          url: resolveObjectUrl(fetched.url, fetched.id),
          repliesCount: 0,
          reblogsCount: 0,
          favouritesCount: 0,
          published: toUtcIso(fetched.published),
          local: false,
          raw: JSON.stringify(fetched),
        });
        const ownerId = (typeof fetched.attributedTo === "string"
          ? fetched.attributedTo
          : (fetched.attributedTo as { id?: string })?.id) ?? "";
        if (!targets.has(ownerId)) targets.set(ownerId, { id: ownerId, statusUris: [] });
        if (!seenStatuses.has(uri)) {
          seenStatuses.add(uri);
          targets.get(ownerId)!.statusUris.push(uri);
        }
      }
    } catch { /* ignore */ }
  }

  if (targets.size === 0) return;

  const comment = typeof activity.content === "string" ? activity.content : "";

  for (const target of targets.values()) {
    const statusIds = target.statusUris.map((uri) => encodeStatusId(uri, uri.startsWith(ctx.baseUrl)));

    // Deduplicate: skip if the same reporter already reported this account with
    // the exact same comment (avoids spamming the moderation queue on retries).
    try {
      const existing = await ctx.db
        .prepare("SELECT id FROM reports WHERE actor_id = ? AND target_id = ? AND comment = ? LIMIT 1")
        .bind(reporterId, target.id, comment)
        .first<{ id: string }>();
      if (existing) continue;
    } catch { /* ignore */ }

    try {
      const reportId = generateId();
      await createReport(
        ctx.db,
        reportId,
        reporterId,
        target.id,
        statusIds.length > 0 ? JSON.stringify(statusIds) : null,
        comment,
        "other",
        null,
        false
      );

      // Run the same Guardian report pipeline used for locally-submitted reports
      // so federated Flags are also AI-managed. The target account must be local
      // (we can only take action on accounts that live here).
      const targetActor = await getActorById(ctx.db, target.id);
      if (ctx.ai && targetActor && targetActor.isLocal) {
        try {
          await evaluateReportWithAI(
            {
              DB: ctx.db,
              AI: ctx.ai,
              EMAIL: ctx.email ?? undefined,
              FROM_EMAIL: ctx.fromEmail,
              INSTANCE_TITLE: ctx.instanceTitle,
            },
            {
              reportId,
              category: "other",
              comment,
              statusIds,
              domain: ctx.baseUrl.replace(/^https?:\/\//, ""),
              target: { id: targetActor.id, username: targetActor.username },
              reporter: { id: reporter.id, username: reporter.username, email: reporter.email },
            }
          );
        } catch (err) {
          console.error("[inbox] Flag AI evaluation error:", err);
        }
      }
    } catch (err) {
      console.error("[inbox] Failed to store incoming Flag:", err);
    }
  }
}

async function handleUpdate(activity: APActivity, ctx: InboxContext): Promise<void> {
  const obj = activity.object as APActor | APNote | undefined;
  if (!obj || typeof obj !== "object") return;

  const actorId = typeof activity.actor === "string" ? activity.actor : (activity.actor as APActor).id;

  // Handle object/status edits (Mastodon 3.5.0+)
  if (obj.type === "Note" || isContentObjectType((obj.type ?? "").split("/").pop() ?? "")) {
    const note = obj as APNote;
    const existing = await getObjectById(ctx.db, note.id);
    if (!existing) {
      // If we don't have the object yet, try to store it as a new remote object
      if (note.attributedTo && note.content) {
        const noteActorId = typeof note.attributedTo === "string"
          ? note.attributedTo
          : (note.attributedTo as APActor | undefined)?.id;
        if (noteActorId) await ensureActorCached(ctx.db, noteActorId);
        const { content, contentWarning } = sanitizeRemoteNoteContent(
          note.content, note.summary, note.sensitive ?? false
        );
        await createObject(ctx.db, {
          id: note.id,
          type: note.type,
          actorId: noteActorId ?? actorId,
          content,
          contentWarning,
          sensitive: note.sensitive ?? false,
          visibility: resolveVisibility(note.to, note.cc),
          inReplyToId: note.inReplyTo ?? null,
          quoteId: extractQuoteId(note as Record<string, unknown>),
          language: note.contentMap ? Object.keys(note.contentMap)[0] : null,
          url: resolveObjectUrl(note.url, note.id),
          repliesCount: 0,
          reblogsCount: 0,
          favouritesCount: 0,
          published: toUtcIso(note.published),
          local: false,
          raw: JSON.stringify(note),
        });
        await saveObjectAttachments(ctx.db, note.id, note.attachment, note.sensitive === true);
        await ensurePollRowsForQuestion(ctx, note);
      }
      return;
    }
    // Only update remote notes, never overwrite local content
    if (existing.actorId !== actorId) return;
    if (existing.local) return;
    // Only apply update when the note has a newer `updated` timestamp
    if (note.updated && existing.updatedAt && new Date(note.updated) <= new Date(existing.updatedAt)) return;
    const { content, contentWarning } = sanitizeRemoteNoteContent(
      note.content, note.summary, note.sensitive ?? false
    );
    await updateObject(ctx.db, note.id, {
      content: content ?? undefined,
      contentWarning,
      sensitive: note.sensitive ?? false,
      language: note.contentMap ? Object.keys(note.contentMap)[0] : undefined,
      raw: JSON.stringify(note),
    });
    await ensurePollRowsForQuestion(ctx, note);
    // Notify local users who interacted with the edited note
    const interacted = await getLocalInteractedActorIds(ctx.db, note.id);
    for (const targetId of interacted) {
      const notif: LocalNotification = {
        id: generateId(),
        type: "update",
        accountId: actorId,
        targetAccountId: targetId,
        objectId: note.id,
        read: false,
        createdAt: new Date().toISOString(),
      };
      await createNotification(ctx.db, notif);
      await broadcastAndPush(ctx, notif);
    }
    return;
  }

  // Handle actor profile updates
  if (["Person", "Service", "Group", "Organization", "Application"].includes(obj.type)) {
    const actor = obj as APActor;

    // Only allow an actor to update its own profile
    if (actor.id !== actorId) {
      return;
    }

    // Never trust publicKey from the activity body — that field is only updated
    // by upsertRemoteActor after a fresh signed fetch from the canonical URL.
    await updateActor(ctx.db, actor.id, {
      displayName: sanitizeFediversePlain(actor.name ?? null),
      summary: sanitizeRemoteActorSummary(actor.summary ?? null),
      avatarUrl: actor.icon?.url ?? null,
      headerUrl: actor.image?.url ?? null,
      discoverable: actor.discoverable ?? true,
      manuallyApprovesFollowers: actor.manuallyApprovesFollowers ?? false,
      alsoKnownAs: actor.alsoKnownAs?.length ? actor.alsoKnownAs : undefined,
    });
  }
}

// ─────────────────────────────────────────
// MLS (Messaging Layer Security) over ActivityPub
// ─────────────────────────────────────────

/** An MLS object envelope as defined by the MLS-in-ActivityPub draft. */
interface APMlsObject {
  id: string;
  type: string | string[];
  content?: string | null;
  mediaType?: string | null;
  encoding?: string | null;
  ciphersuite?: string;
  conversation?: string | null;
  to?: unknown;
  cc?: unknown;
  published?: string;
}

function mlsObjectType(obj: { type?: string | string[] | unknown }): string {
  return mlsObjectTypeFromType(obj.type) ?? "";
}

function activityActorId(activity: APActivity): string {
  return typeof activity.actor === "string" ? activity.actor : (activity.actor as { id?: string })?.id ?? "";
}

/** Flatten `to`/`cc` (string | array | Link) into IRIs. */
function collectAudience(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object") {
        const href = (item as { href?: unknown }).href;
        if (typeof href === "string") out.push(href);
      }
    }
    return out;
  }
  if (typeof value === "object") {
    const href = (value as { href?: unknown }).href;
    if (typeof href === "string") return [href];
  }
  return [];
}

const PUBLIC_IRI = "https://www.w3.org/ns/activitystreams#Public";

/**
 * Resolve the explicit local actors a delivered MLS activity is addressed to.
 * Only actor IRIs count — collection/public recipients are not stored.
 */
async function resolveLocalMlsRecipients(
  ctx: InboxContext,
  activity: APActivity
): Promise<{ id: string }[]> {
  const raw = [...collectAudience(activity.to), ...collectAudience(activity.cc)];
  const actors: { id: string }[] = [];
  for (const iri of new Set(raw)) {
    if (iri === PUBLIC_IRI || iri === "as:Public" || iri === "Public") continue;
    if (!iri.startsWith(ctx.baseUrl + "/")) continue;
    const actor = await getActorById(ctx.db, iri);
    if (actor?.isLocal) actors.push({ id: actor.id });
  }
  return actors;
}

/** True when any mls_messages row references this object id. */
async function mlsObjectExists(ctx: InboxContext, objectId: string): Promise<boolean> {
  const row = await ctx.db
    .prepare("SELECT id FROM mls_messages WHERE object_id = ? LIMIT 1")
    .bind(objectId)
    .first<{ id: string }>();
  return Boolean(row);
}

/** Store one delivered MLS activity row per explicit local recipient. */
async function routeMlsToRecipients(
  activity: APActivity,
  ctx: InboxContext,
  object: APMlsObject,
  objType: string
): Promise<void> {
  const actorId = activityActorId(activity);
  if (!actorId) return;
  const author = await ensureActorCached(ctx.db, actorId);
  if (!author) return;
  const recipients = await resolveLocalMlsRecipients(ctx, activity);
  if (recipients.length === 0) return;

  const published = toUtcIso(object.published ?? activity.published);
  for (const recipient of recipients) {
    try {
      await insertMlsMessage(ctx.db, {
        id: activity.id,
        type: activity.type,
        actorId,
        recipientId: recipient.id,
        objectId: object.id,
        objectType: objType,
        conversation: object.conversation ?? null,
        mediaType: object.mediaType ?? null,
        encoding: object.encoding ?? null,
        content: object.content ?? null,
        raw: JSON.stringify(activity),
        published,
      });
      // Surface the encrypted message in the recipient's notifications.
      const notif: LocalNotification = {
        id: generateId(),
        type: "encrypted",
        accountId: actorId,
        targetAccountId: recipient.id,
        objectId: object.id,
        read: false,
        createdAt: new Date().toISOString(),
      };
      await createNotification(ctx.db, notif);
      await broadcastAndPush(ctx, notif);
    } catch {
      /* duplicate / FK race — ignore */
    }
  }
}

/** Store a lifecycle activity (Add/Remove/Delete) for its local recipients. */
async function routeMlsLifecycle(
  activity: APActivity,
  ctx: InboxContext,
  objectId: string,
  objType: string | null
): Promise<void> {
  const actorId = activityActorId(activity);
  if (!actorId) return;
  const author = await ensureActorCached(ctx.db, actorId);
  if (!author) return;
  const recipients = await resolveLocalMlsRecipients(ctx, activity);
  if (recipients.length === 0) return;

  const published = toUtcIso(activity.published);
  for (const recipient of recipients) {
    try {
      await insertMlsMessage(ctx.db, {
        id: activity.id,
        type: activity.type,
        actorId,
        recipientId: recipient.id,
        objectId,
        objectType: objType,
        conversation: null,
        mediaType: null,
        encoding: null,
        content: null,
        raw: JSON.stringify(activity),
        published,
      });
    } catch {
      /* ignore */
    }
  }
}

/**
 * A Create carrying an MLS object (RFC 9420 KeyPackage/Welcome/GroupInfo or
 * MLSTM Public/PrivateMessage envelope). The server never decrypts — it caches
 * key packages and routes encrypted envelopes to the explicit recipients.
 */
async function handleMlsCreate(
  activity: APActivity,
  ctx: InboxContext,
  obj: APMlsObject
): Promise<void> {
  if (!obj?.id) return;
  const objType = mlsObjectType(obj);
  const actorId = activityActorId(activity);
  if (!actorId) return;

  if (objType === "KeyPackage") {
    // Cache the key package keyed by its object IRI. Owned by the sender, so a
    // local actor's keyPackages collection is backed by these rows.
    try {
      await upsertMlsKeyPackage(ctx.db, {
        id: obj.id,
        actorId,
        objectId: obj.id,
        ciphersuite: obj.ciphersuite ?? null,
        mediaType: obj.mediaType ?? null,
        encoding: obj.encoding ?? null,
        content: obj.content ?? null,
        isActive: true,
      });
    } catch {
      /* ignore */
    }
    return;
  }

  // Public MLS messages are additionally surfaced on the public timeline as
  // "encrypted envelope" posts (the ciphertext is never decrypted).
  const actor = await ensureActorCached(ctx.db, actorId);
  if (!actor) return;
  await storePublicMlsEnvelope(
    ctx.db,
    activity,
    obj,
    objType,
    actorId,
    toUtcIso(obj.published ?? activity.published),
    false
  );

  await routeMlsToRecipients(activity, ctx, obj, objType);
}

/** Add(KeyPackage) — re-activate a cached key package of the sender. */
async function handleAdd(activity: APActivity, ctx: InboxContext): Promise<void> {
  const object = activity.object as APActivity | string | undefined;
  const objectId = typeof object === "string" ? object : (object as { id?: string })?.id;
  if (!objectId) return;
  const actorId = activityActorId(activity);

  const kp = await getMlsKeyPackageByObjectId(ctx.db, objectId);
  if (kp && kp.actorId === actorId) {
    await setMlsKeyPackageActive(ctx.db, objectId, true);
  }
  await routeMlsLifecycle(activity, ctx, objectId, "KeyPackage");
}

/** Remove(KeyPackage) — deactivate a cached key package of the sender. */
async function handleRemove(activity: APActivity, ctx: InboxContext): Promise<void> {
  const object = activity.object as APActivity | string | undefined;
  const objectId = typeof object === "string" ? object : (object as { id?: string })?.id;
  if (!objectId) return;
  const actorId = activityActorId(activity);

  const kp = await getMlsKeyPackageByObjectId(ctx.db, objectId);
  if (kp && kp.actorId === actorId) {
    await setMlsKeyPackageActive(ctx.db, objectId, false);
  }
  await routeMlsLifecycle(activity, ctx, objectId, "KeyPackage");
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

/**
 * Ensure a remote actor is present in the local DB before writing any row that
 * references actors(id) via a FOREIGN KEY. Returns the local record, or null
 * if the actor cannot be resolved.
 */
async function ensureActorCached(db: import("@cloudflare/workers-types").D1Database, actorId: string): Promise<import("@/lib/types").LocalActor | null> {
  let actor = await getActorById(db, actorId);
  if (!actor) {
    try {
      const fetched = await fetchRemoteObject(actorId) as APActor | null;
      if (fetched?.publicKey?.publicKeyPem) {
        await upsertRemoteActor(db, fetched);
        actor = await getActorById(db, actorId);
      }
    } catch { /* ignore network errors */ }
  }
  return actor;
}

/** Normalize any ISO8601 date string (including tz-offset variants) to UTC Z format. */
function toUtcIso(dateStr: string | undefined | null): string {
  if (!dateStr) return new Date().toISOString();
  try { return new Date(dateStr).toISOString(); } catch { return new Date().toISOString(); }
}

/**
 * Normalize an object's presentation URL. AS allows `url` to be a string or a
 * Link/array; pick the first usable string so it can be stored in the DB column.
 */
function resolveObjectUrl(url: unknown, fallback: string): string {
  if (typeof url === "string") return url;
  if (Array.isArray(url)) {
    for (const u of url) {
      if (typeof u === "string") return u;
      if (u && typeof u === "object") {
        const href = (u as Record<string, unknown>).href;
        if (typeof href === "string") return href;
      }
    }
    return fallback;
  }
  if (url && typeof url === "object") {
    const href = (url as Record<string, unknown>).href;
    if (typeof href === "string") return href;
  }
  return fallback;
}

/**
 * Whether the HTTP-signature signer is allowed to act as the activity's actor.
 *
 * Requires an exact IRI match. Federation servers vouch for an activity by
 * signing it with the private key of the activity's own actor, so the signature
 * keyId owner MUST be that same actor. (For a standard keyId like
 * `https://host/users/alice#main-key`, stripping the fragment yields the
 * actor's canonical IRI.) We do not support embedded (Linked-Data) signatures,
 * so any truly cross-actor activity — including actor spoofing from another
 * account on the same domain — is rejected. A hostname-only comparison would
 * let any user on a host post as any other user on that same host.
 */
function signerOwnsActor(signingActorId: string, actorId: string): boolean {
  return signingActorId === actorId;
}

function resolveVisibility(to: unknown = [], cc: unknown = []): "public" | "unlisted" | "followers" | "direct" {
  // Some AP implementations send a plain string instead of an array when there
  // is a single recipient — coerce to array so .includes() and .some() are safe.
  const toArr: string[] = Array.isArray(to) ? to : (to ? [to as string] : []);
  const ccArr: string[] = Array.isArray(cc) ? cc : (cc ? [cc as string] : []);
  // Implementations may use the full IRI, the compact "as:Public", or just "Public".
  // http:// and https:// variants both appear in the wild.
  const isPublic = (v: string) =>
    v === "https://www.w3.org/ns/activitystreams#Public" ||
    v === "http://www.w3.org/ns/activitystreams#Public" ||
    v === "as:Public" ||
    v === "Public";
  if (toArr.some(isPublic)) return "public";
  if (ccArr.some(isPublic)) return "unlisted";
  if (toArr.some((t) => t.includes("/followers"))) return "followers";
  return "direct";
}

// ─────────────────────────────────────────
// WebRTC Call Handlers
// ─────────────────────────────────────────

/**
 * Resolve the local recipient from activity.to when the activity arrives via
 * the shared inbox (ctx.recipient is null).  Returns a shallow copy of ctx
 * with recipient populated, or the original ctx if resolution fails.
 */
async function resolveCtxRecipient(activity: APActivity, ctx: InboxContext): Promise<InboxContext> {
  if (ctx.recipient) return ctx;
  const to = Array.isArray(activity.to) ? activity.to[0] : (typeof activity.to === "string" ? activity.to : null);
  if (!to || typeof to !== "string" || !to.startsWith(ctx.baseUrl + "/")) return ctx;
  const username = to.split("/").pop();
  if (!username) return ctx;
  const domain = new URL(ctx.baseUrl).hostname;
  const actor = await getActorByUsername(ctx.db, username, domain);
  if (!actor?.privateKeyPem) return ctx;
  return { ...ctx, recipient: { id: actor.id, username: actor.username, privateKeyPem: actor.privateKeyPem } };
}

async function handleCallOffer(activity: APActivity, ctx: InboxContext): Promise<void> {
  if (!ctx.timelineStream || !ctx.recipient) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = activity.object as Record<string, any> | undefined;
  if (!obj) return;

  const callerIRI = typeof activity.actor === "string" ? activity.actor : (activity.actor as APActor).id;
  const callee = ctx.recipient;

  // Resolve display info for the caller
  const callerActor = await getActorById(ctx.db, callerIRI);
  const callerAcct = callerActor
    ? (callerActor.domain === new URL(ctx.baseUrl).hostname
        ? callerActor.username
        : `${callerActor.username}@${callerActor.domain}`)
    : callerIRI;

  // Extract call ID from the object IRI (last path segment)
  const callId = (obj.id as string ?? "").split("/").pop() ?? crypto.randomUUID();
  const callType = (obj.callType ?? "audio") as "audio" | "video" | "screen";
  const offerSdp = (obj.sdp ?? "") as string;

  // Persist a local call session so the callee can POST the answer/ICE to our
  // own /api/v1/calls/{id} endpoint (the session only exists on the caller's
  // instance otherwise, causing 404s).
  if (ctx.kv) {
    const session: CallSession = {
      id: callId,
      callerId: callerIRI,
      calleeId: callee.id,
      callerAcct,
      calleeAcct: callee.username,
      callType,
      offerSdp,
      answerSdp: null,
      state: "pending",
      createdAt: new Date().toISOString(),
    };
    await ctx.kv.put(`call:${callId}`, JSON.stringify(session), { expirationTtl: 600 });
  }

  await broadcastCallEvent(ctx.timelineStream, callee.username, {
    type: "call.incoming",
    callId,
    callType,
    callerAcct,
    callerDisplayName: callerActor?.displayName ?? callerActor?.username ?? callerAcct,
    callerAvatar: callerActor?.avatarUrl ?? null,
    offerSdp,
  });
}

async function handleCallAnswer(activity: APActivity, ctx: InboxContext): Promise<void> {
  ctx = await resolveCtxRecipient(activity, ctx);
  if (!ctx.timelineStream || !ctx.recipient) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = activity.object as Record<string, any> | undefined;
  if (!obj) return;

  const callId = (obj.id as string ?? "").split("/").pop() ?? "";
  const callerId = ctx.recipient.id;
  const callerUsername = ctx.recipient.username;

  await broadcastCallEvent(ctx.timelineStream, callerUsername, {
    type: "call.answered",
    callId,
    answerSdp: obj.sdp ?? "",
  });

  // Also relay via the signaling DO for low-latency ICE exchange
  if (callId && ctx.baseUrl) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ns = (ctx as any).callSignaling as typeof ctx.timelineStream | undefined;
      if (ns) {
        const doId = ns.idFromName(callId);
        const stub = ns.get(doId);
        await stub.fetch(`https://call-do/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "answer", sdp: obj.sdp }),
        });
      }
    } catch { /* best-effort */ }
  }
  void callerId; // used for context, suppress unused warning
}

async function handleCallIceCandidate(activity: APActivity, ctx: InboxContext): Promise<void> {
  ctx = await resolveCtxRecipient(activity, ctx);
  if (!ctx.recipient) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = activity.object as Record<string, any> | undefined;
  if (!obj) return;

  const callId = (obj.id as string ?? "").split("/").pop() ?? "";
  if (!callId) return;

  const candidate = obj.candidate
    ? (typeof obj.candidate === "string" ? JSON.parse(obj.candidate) : obj.candidate)
    : null;
  if (!candidate) return;

  // Relay via streaming for real-time delivery to the recipient
  if (ctx.timelineStream) {
    await broadcastCallEvent(ctx.timelineStream, ctx.recipient.username, {
      type: "call.ice",
      callId,
      candidate,
    });
  }
}

async function handleCallHangup(activity: APActivity, ctx: InboxContext): Promise<void> {
  ctx = await resolveCtxRecipient(activity, ctx);
  if (!ctx.recipient) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = activity.object as Record<string, any> | undefined;
  const callId = (obj?.id as string ?? "").split("/").pop() ?? "";

  if (ctx.timelineStream) {
    await broadcastCallEvent(ctx.timelineStream, ctx.recipient.username, {
      type: "call.ended",
      callId,
    });
  }
}

async function handleCallRenegotiate(activity: APActivity, ctx: InboxContext): Promise<void> {
  ctx = await resolveCtxRecipient(activity, ctx);
  if (!ctx.recipient) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = activity.object as Record<string, any> | undefined;
  if (!obj) return;
  const callId = (obj.id as string ?? "").split("/").pop() ?? "";
  if (!callId || !obj.sdp) return;

  if (ctx.timelineStream) {
    await broadcastCallEvent(ctx.timelineStream, ctx.recipient.username, {
      type: "call.renegotiate",
      callId,
      sdp: obj.sdp as string,
    });
  }
}

async function handleCallRenegotiateAnswer(activity: APActivity, ctx: InboxContext): Promise<void> {
  ctx = await resolveCtxRecipient(activity, ctx);
  if (!ctx.recipient) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = activity.object as Record<string, any> | undefined;
  if (!obj) return;
  const callId = (obj.id as string ?? "").split("/").pop() ?? "";
  if (!callId || !obj.sdp) return;

  if (ctx.timelineStream) {
    await broadcastCallEvent(ctx.timelineStream, ctx.recipient.username, {
      type: "call.renegotiate-answer",
      callId,
      sdp: obj.sdp as string,
    });
  }
}

async function saveObjectAttachments(
  db: D1Database,
  objectId: string,
  attachment: APAttachment[] | undefined,
  sensitive = false
): Promise<void> {
  if (!Array.isArray(attachment)) return;
  for (const att of attachment) {
    if (!att?.url) continue;
    try {
      await createAttachment(db, {
        id: att.id || generateId(),
        objectId,
        type: apAttachmentType(att.type, att.mediaType),
        url: att.url,
        remoteUrl: att.url,
        description: att.name ?? null,
        blurhash: att.blurhash ?? null,
        width: att.width ?? null,
        height: att.height ?? null,
        fileSize: null,
        mimeType: att.mediaType ?? null,
        sensitive: sensitive || (att as { sensitive?: boolean }).sensitive === true,
        createdAt: new Date().toISOString(),
      });
    } catch { /* ignore */ }
  }
}
