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
  getPollByObjectId,
  getPollOptions,
  getPollVotesByActor,
  createPollVotes,
  getAllCustomEmojis,
} from "@/lib/db";
import {
  buildAccept,
  generateId,
  activityIRI,
  extractUsername,
} from "./utils";
import { upsertCustomEmoji } from "@/lib/db";
import { deliverToInbox, fetchRemoteObject } from "./federation";
import { broadcastNotificationEvent, broadcastPublicStatus, broadcastHomeStatus, broadcastCallEvent } from "@/lib/streaming/broadcast";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { sanitizeRemoteNoteContent, sanitizeRemoteActorSummary, sanitizeFediversePlain } from "./sanitize";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DONamespace = { idFromName(name: string): any; get(id: any): { fetch(input: string | URL, init?: RequestInit): Promise<Response> } };
type KVNamespace = { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };

interface InboxContext {
  db: D1Database;
  baseUrl: string;
  /** KV namespace — used to persist call sessions for cross-instance WebRTC signaling. */
  kv?: KVNamespace | null;
  recipient?: { id: string; username: string; privateKeyPem: string } | null;
  /** A local actor key to use when making signed HTTP GET requests to remote servers. */
  signingKey?: { id: string; privateKeyPem: string } | null;
  /** DO namespace for streaming — used to push notification events to connected clients. */
  timelineStream?: DONamespace | null;
}

export async function processInboxActivity(
  activity: APActivity,
  ctx: InboxContext
): Promise<void> {
  const type = (activity.type ?? "").toLowerCase();

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
      case "update":
        await handleUpdate(activity, ctx);
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
      default:
        // Ignore unknown activity types
        break;
    }
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────

async function handleCreate(activity: APActivity, ctx: InboxContext): Promise<void> {
  const obj = activity.object as APNote | undefined;
  if (!obj || typeof obj !== "object" || obj.type !== "Note") return;

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
  if (existing) return; // Already stored

  const { content, contentWarning } = sanitizeRemoteNoteContent(
    obj.content,
    obj.summary,
    obj.sensitive ?? false
  );

  await createObject(ctx.db, {
    id: obj.id,
    type: "Note",
    actorId,
    content,
    contentWarning,
    sensitive: obj.sensitive ?? false,
    visibility: resolveVisibility(obj.to, obj.cc),
    inReplyToId: obj.inReplyTo ?? null,
    language: obj.contentMap ? Object.keys(obj.contentMap)[0] : null,
    url: obj.url ?? obj.id,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: toUtcIso(obj.published),
    local: false,
    raw: JSON.stringify(obj),
  });

  const storedAttachments: LocalAttachment[] = [];
  if (Array.isArray(obj.attachment)) {
    for (const attachment of obj.attachment as APAttachment[]) {
      if (!attachment?.url) continue;
      const localAttachment: LocalAttachment = {
        id: attachment.id || generateId(),
        objectId: obj.id,
        type: attachment.type.toLowerCase(),
        url: attachment.url,
        remoteUrl: attachment.url,
        description: attachment.name ?? null,
        blurhash: attachment.blurhash ?? null,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
        fileSize: null,
        mimeType: attachment.mediaType ?? null,
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
            await createNotification(ctx.db, {
              id: generateId(),
              type: "mention",
              accountId: actorId,
              targetAccountId: mentionedActor.id,
              objectId: obj.id,
              read: false,
              createdAt: new Date().toISOString(),
            });
            if (ctx.timelineStream) void broadcastNotificationEvent(ctx.timelineStream, mentionedActor.id).catch(() => {});
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
          await createNotification(ctx.db, {
            id: generateId(),
            type: "mention",
            accountId: actorId,
            targetAccountId: replyTarget.actorId,
            objectId: obj.id,
            read: false,
            createdAt: new Date().toISOString(),
          });
          if (ctx.timelineStream) void broadcastNotificationEvent(ctx.timelineStream, replyTarget.actorId).catch(() => {});
        }
      }
    }
  }

  // Broadcast to timeline streaming clients (fire-and-forget)
  if (ctx.timelineStream) {
    const statusVisibility = resolveVisibility(obj.to, obj.cc);
    if (statusVisibility === "public" || statusVisibility === "unlisted") {
      const domain = new URL(ctx.baseUrl).hostname;
      const published = toUtcIso(obj.published);
      const allEmojis = await getAllCustomEmojis(ctx.db);
      const serializedStatus = serializeStatus(
        {
          id: obj.id, type: "Note", actorId, content,
          contentWarning, sensitive: obj.sensitive ?? false, visibility: statusVisibility,
          inReplyToId: obj.inReplyTo ?? null,
          language: obj.contentMap ? Object.keys(obj.contentMap)[0] : null,
          url: obj.url ?? obj.id, repliesCount: 0, reblogsCount: 0, favouritesCount: 0,
          published, updatedAt: published, local: false, raw: JSON.stringify(obj),
        },
        author,
        domain,
        { attachments: storedAttachments, emojis: allEmojis }
      );
      const broadcastTasks: Promise<void>[] = [
        broadcastPublicStatus(ctx.timelineStream, serializedStatus, false),
      ];

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
  if (!ctx.recipient) return;
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const targetId = typeof activity.object === "string" ? activity.object : (activity.object as APActor)?.id;

  if (!targetId || targetId !== ctx.recipient.id) return;

  const recipient = await getActorById(ctx.db, ctx.recipient.id);
  if (!recipient) return;

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
    const acceptActivity = buildAccept(ctx.baseUrl, ctx.recipient.id, activity, acceptId);

    // Only update counts and create notification for brand-new follows.
    if (!existing) {
      await updateActor(ctx.db, ctx.recipient.id, {
        followersCount: (recipient.followersCount ?? 0) + 1,
      });
      await createNotification(ctx.db, {
        id: generateId(),
        type: "follow",
        accountId: actorId,
        targetAccountId: ctx.recipient.id,
        objectId: null,
        read: false,
        createdAt: new Date().toISOString(),
      });
      if (ctx.timelineStream) void broadcastNotificationEvent(ctx.timelineStream, ctx.recipient.id).catch(() => {});
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
        `${ctx.recipient.id}#main-key`,
        ctx.recipient.privateKeyPem
      );
    }
  } else if (!existing) {
    await createNotification(ctx.db, {
      id: generateId(),
      type: "follow_request",
      accountId: actorId,
      targetAccountId: ctx.recipient.id,
      objectId: null,
      read: false,
      createdAt: new Date().toISOString(),
    });
    if (ctx.timelineStream) void broadcastNotificationEvent(ctx.timelineStream, ctx.recipient.id).catch(() => {});
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
        await updateActor(ctx.db, rows.actor_id, {
          followingCount: (follower.followingCount ?? 0) + 1,
        });
      }
      const followed = await getActorById(ctx.db, rows.target_id);
      if (followed) {
        await updateActor(ctx.db, rows.target_id, {
          followersCount: (followed.followersCount ?? 0) + 1,
        });
      }
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
      await deleteFollow(ctx.db, actorId, targetId);
      const target = await getActorById(ctx.db, targetId);
      if (target) {
        await updateActor(ctx.db, targetId, {
          followersCount: Math.max(0, (target.followersCount ?? 0) - 1),
        });
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
        const NOTE_LIKE_TYPES = ["Note", "Article", "Page", "Video", "Audio", "Image", "Question"];
        if (NOTE_LIKE_TYPES.includes((fetched.type ?? "Note") as string)) {
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
            language: fetched.contentMap ? Object.keys(fetched.contentMap)[0] : null,
            url: fetched.url ?? fetched.id,
            repliesCount: 0,
            reblogsCount: 0,
            favouritesCount: 0,
            published: toUtcIso(fetched.published),
            local: false,
            raw: JSON.stringify(fetched),
          });
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
      await createNotification(ctx.db, {
        id: generateId(),
        type: "favourite",
        accountId: actorId,
        targetAccountId: likedObject.actorId,
        objectId,
        read: false,
        createdAt: new Date().toISOString(),
      });
      if (ctx.timelineStream) void broadcastNotificationEvent(ctx.timelineStream, likedObject.actorId).catch(() => {});
    }
  }
}

async function handleAnnounce(activity: APActivity, ctx: InboxContext): Promise<void> {
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const objectId = typeof activity.object === "string" ? activity.object : (activity.object as APNote)?.id;
  if (!objectId) return;

  // Ensure actor is in DB (FK on announces.actor_id)
  const announcerActor = await ensureActorCached(ctx.db, actorId);
  if (!announcerActor) return;

  // If the boosted post is not yet stored locally, fetch and save it so it
  // appears in the federated timeline regardless of whether we follow the author.
  const knownObj = await getObjectById(ctx.db, objectId);
  if (!knownObj && objectId.startsWith("https://")) {
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
      const NOTE_LIKE_TYPES = ["Note", "Article", "Page", "Video", "Audio", "Image"];
      if (fetched && NOTE_LIKE_TYPES.includes((fetched as APNote).type as string)) {
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
          type: (fetched as APNote).type ?? "Note",
          actorId: noteActorId ?? actorId,
          content,
          contentWarning,
          sensitive: fetched.sensitive ?? false,
          visibility: resolveVisibility(fetched.to, fetched.cc),
          inReplyToId: fetched.inReplyTo ?? null,
          language: fetched.contentMap ? Object.keys(fetched.contentMap)[0] : null,
          url: fetched.url ?? fetched.id,
          repliesCount: 0,
          reblogsCount: 0,
          favouritesCount: 0,
          published: toUtcIso(fetched.published),
          local: false,
          raw: JSON.stringify(fetched),
        });
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
      await createNotification(ctx.db, {
        id: generateId(),
        type: "reblog",
        accountId: actorId,
        targetAccountId: resolvedObj.actorId,
        objectId,
        read: false,
        createdAt: new Date().toISOString(),
      });
      if (ctx.timelineStream) void broadcastNotificationEvent(ctx.timelineStream, resolvedObj.actorId).catch(() => {});
    }
  }
}

async function handleDelete(activity: APActivity, ctx: InboxContext): Promise<void> {
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const objectId = typeof activity.object === "string"
    ? activity.object
    : (activity.object as { id: string })?.id;
  if (!objectId) return;

  const obj = await getObjectById(ctx.db, objectId);
  if (obj && obj.actorId === actorId) {
    await deleteObject(ctx.db, objectId);
  }
}

async function handleUpdate(activity: APActivity, ctx: InboxContext): Promise<void> {
  const obj = activity.object as APActor | APNote | undefined;
  if (!obj || typeof obj !== "object") return;

  const actorId = typeof activity.actor === "string" ? activity.actor : (activity.actor as APActor).id;

  // Handle note/status edits (Mastodon 3.5.0+)
  if (obj.type === "Note") {
    const note = obj as APNote;
    const existing = await getObjectById(ctx.db, note.id);
    if (!existing) {
      // If we don't have the note yet, try to store it as a new remote object
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
          type: "Note",
          actorId: noteActorId ?? actorId,
          content,
          contentWarning,
          sensitive: note.sensitive ?? false,
          visibility: resolveVisibility(note.to, note.cc),
          inReplyToId: note.inReplyTo ?? null,
          language: note.contentMap ? Object.keys(note.contentMap)[0] : null,
          url: note.url ?? note.id,
          repliesCount: 0,
          reblogsCount: 0,
          favouritesCount: 0,
          published: toUtcIso(note.published),
          local: false,
          raw: JSON.stringify(note),
        });
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
    });
  }
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
