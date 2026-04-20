/**
 * Inbox activity processor — handles all incoming ActivityPub activities.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { APActivity, APNote, APActor } from "@/lib/types";
import {
  getActorById,
  getFollow,
  createFollow,
  updateFollowState,
  deleteFollow,
  getObjectById,
  createObject,
  deleteObject,
  createLike,
  deleteLike,
  createAnnounce,
  deleteAnnounce,
  createNotification,
  updateActor,
} from "@/lib/db";
import {
  buildAccept,
  generateId,
  activityIRI,
  extractUsername,
} from "./utils";
import { deliverToInbox } from "./federation";

interface InboxContext {
  db: D1Database;
  baseUrl: string;
  recipient?: { id: string; username: string; privateKeyPem: string } | null;
}

export async function processInboxActivity(
  activity: APActivity,
  ctx: InboxContext
): Promise<void> {
  const type = (activity.type ?? "").toLowerCase();

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
    default:
      // Ignore unknown activity types
      break;
  }
}

// ─────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────

async function handleCreate(activity: APActivity, ctx: InboxContext): Promise<void> {
  const obj = activity.object as APNote | undefined;
  if (!obj || typeof obj !== "object" || obj.type !== "Note") return;

  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;

  // Ensure remote actor is cached
  let author = await getActorById(ctx.db, actorId);
  if (!author) return; // Actor not cached, skip

  const existing = await getObjectById(ctx.db, obj.id);
  if (existing) return; // Already stored

  await createObject(ctx.db, {
    id: obj.id,
    type: "Note",
    actorId,
    content: obj.content ?? null,
    contentWarning: obj.sensitive ? (obj.summary ?? null) : null,
    sensitive: obj.sensitive ?? false,
    visibility: resolveVisibility(obj.to, obj.cc),
    inReplyToId: obj.inReplyTo ?? null,
    language: obj.contentMap ? Object.keys(obj.contentMap)[0] : null,
    url: obj.url ?? obj.id,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: obj.published,
    local: false,
    raw: JSON.stringify(obj),
  });

  // Notify mentioned users
  if (obj.inReplyTo) {
    const replyTarget = await getObjectById(ctx.db, obj.inReplyTo);
    if (replyTarget?.actorId) {
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
      }
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
    // Auto-accept: send Accept activity back
    const acceptId = generateId();
    const acceptActivity = buildAccept(ctx.baseUrl, ctx.recipient.id, activity, acceptId);

    // Update follower count
    await updateActor(ctx.db, ctx.recipient.id, {
      followersCount: (recipient.followersCount ?? 0) + 1,
    });

    // Deliver Accept to requester
    const requesterActor = await getActorById(ctx.db, actorId);
    if (requesterActor?.inbox) {
      await deliverToInbox(
        requesterActor.inbox,
        acceptActivity,
        `${ctx.recipient.id}#main-key`,
        ctx.recipient.privateKeyPem
      );
    }

    await createNotification(ctx.db, {
      id: generateId(),
      type: "follow",
      accountId: actorId,
      targetAccountId: ctx.recipient.id,
      objectId: null,
      read: false,
      createdAt: new Date().toISOString(),
    });
  } else {
    await createNotification(ctx.db, {
      id: generateId(),
      type: "follow_request",
      accountId: actorId,
      targetAccountId: ctx.recipient.id,
      objectId: null,
      read: false,
      createdAt: new Date().toISOString(),
    });
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
    .first<{ id: string; target_id: string; actor_id: string }>();

  if (rows) {
    await updateFollowState(ctx.db, rows.id, "accepted");
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
  const objectId = typeof activity.object === "string" ? activity.object : (activity.object as APNote)?.id;
  if (!objectId) return;

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

    const obj = await getObjectById(ctx.db, objectId);
    if (obj) {
      const owner = await getActorById(ctx.db, obj.actorId);
      if (owner?.isLocal) {
        await createNotification(ctx.db, {
          id: generateId(),
          type: "favourite",
          accountId: actorId,
          targetAccountId: obj.actorId,
          objectId,
          read: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }
}

async function handleAnnounce(activity: APActivity, ctx: InboxContext): Promise<void> {
  const actorId = typeof activity.actor === "string" ? activity.actor : activity.actor.id;
  const objectId = typeof activity.object === "string" ? activity.object : (activity.object as APNote)?.id;
  if (!objectId) return;

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

    const obj = await getObjectById(ctx.db, objectId);
    if (obj) {
      const owner = await getActorById(ctx.db, obj.actorId);
      if (owner?.isLocal) {
        await createNotification(ctx.db, {
          id: generateId(),
          type: "reblog",
          accountId: actorId,
          targetAccountId: obj.actorId,
          objectId,
          read: false,
          createdAt: new Date().toISOString(),
        });
      }
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

  // Handle actor profile updates
  if (["Person", "Service", "Group", "Organization", "Application"].includes(obj.type)) {
    const actor = obj as APActor;
    await updateActor(ctx.db, actor.id, {
      displayName: actor.name ?? null,
      summary: actor.summary ?? null,
      avatarUrl: actor.icon?.url ?? null,
      headerUrl: actor.image?.url ?? null,
      publicKeyPem: actor.publicKey?.publicKeyPem ?? "",
      discoverable: actor.discoverable ?? true,
      manuallyApprovesFollowers: actor.manuallyApprovesFollowers ?? false,
    });
  }
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function resolveVisibility(to: string[] = [], cc: string[] = []): "public" | "unlisted" | "followers" | "direct" {
  const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
  if (to.includes(PUBLIC)) return "public";
  if (cc.includes(PUBLIC)) return "unlisted";
  if (to.some((t) => t.includes("/followers"))) return "followers";
  return "direct";
}
