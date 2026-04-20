import { DEFAULT_CONTEXT, PUBLIC_ADDRESS } from "./vocab";
import type { APActor, APNote, APActivity, APCollection, APCollectionPage } from "@/lib/types";

// ─────────────────────────────────────────
// ID generation
// ─────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID();
}

export function actorIRI(baseUrl: string, username: string): string {
  return `${baseUrl}/users/${username.toLowerCase()}`;
}

export function objectIRI(baseUrl: string, id: string): string {
  return `${baseUrl}/objects/${id}`;
}

export function activityIRI(baseUrl: string, id: string): string {
  return `${baseUrl}/activities/${id}`;
}

export function inboxIRI(baseUrl: string, username: string): string {
  return `${actorIRI(baseUrl, username)}/inbox`;
}

export function outboxIRI(baseUrl: string, username: string): string {
  return `${actorIRI(baseUrl, username)}/outbox`;
}

export function followersIRI(baseUrl: string, username: string): string {
  return `${actorIRI(baseUrl, username)}/followers`;
}

export function followingIRI(baseUrl: string, username: string): string {
  return `${actorIRI(baseUrl, username)}/following`;
}

export function likedIRI(baseUrl: string, username: string): string {
  return `${actorIRI(baseUrl, username)}/liked`;
}

export function keyIRI(baseUrl: string, username: string): string {
  return `${actorIRI(baseUrl, username)}#main-key`;
}

// ─────────────────────────────────────────
// Actor builder
// ─────────────────────────────────────────

export function buildActor(
  baseUrl: string,
  username: string,
  options: {
    displayName?: string;
    summary?: string;
    avatarUrl?: string | null;
    headerUrl?: string | null;
    publicKeyPem: string;
    manuallyApprovesFollowers?: boolean;
    discoverable?: boolean;
    isBot?: boolean;
    followersCount?: number;
    followingCount?: number;
    statusesCount?: number;
    published?: string;
  }
): APActor {
  const id = actorIRI(baseUrl, username);
  const actor: APActor = {
    "@context": DEFAULT_CONTEXT,
    id,
    type: options.isBot ? "Service" : "Person",
    preferredUsername: username,
    name: options.displayName ?? username,
    summary: options.summary ?? "",
    url: id,
    inbox: inboxIRI(baseUrl, username),
    outbox: outboxIRI(baseUrl, username),
    followers: followersIRI(baseUrl, username),
    following: followingIRI(baseUrl, username),
    liked: likedIRI(baseUrl, username),
    publicKey: {
      id: keyIRI(baseUrl, username),
      owner: id,
      publicKeyPem: options.publicKeyPem,
    },
    manuallyApprovesFollowers: options.manuallyApprovesFollowers ?? false,
    discoverable: options.discoverable ?? true,
    indexable: options.discoverable ?? true,
    published: options.published ?? new Date().toISOString(),
    endpoints: {
      sharedInbox: `${baseUrl}/inbox`,
    },
  };

  if (options.avatarUrl) {
    actor.icon = { type: "Image", id: options.avatarUrl, url: options.avatarUrl, mediaType: "image/webp" };
  }
  if (options.headerUrl) {
    actor.image = { type: "Image", id: options.headerUrl, url: options.headerUrl, mediaType: "image/webp" };
  }

  return actor;
}

// ─────────────────────────────────────────
// Note builder
// ─────────────────────────────────────────

export function buildNote(
  baseUrl: string,
  id: string,
  options: {
    actorUsername: string;
    content: string;
    published: string;
    visibility: "public" | "unlisted" | "followers" | "direct";
    inReplyTo?: string;
    sensitive?: boolean;
    summary?: string;
    language?: string;
    to?: string[];
    cc?: string[];
  }
): APNote {
  const actorId = actorIRI(baseUrl, options.actorUsername);
  const followers = followersIRI(baseUrl, options.actorUsername);
  const noteId = objectIRI(baseUrl, id);

  let to: string[];
  let cc: string[];

  switch (options.visibility) {
    case "public":
      to = options.to ?? [PUBLIC_ADDRESS];
      cc = options.cc ?? [followers];
      break;
    case "unlisted":
      to = options.to ?? [followers];
      cc = options.cc ?? [PUBLIC_ADDRESS];
      break;
    case "followers":
      to = options.to ?? [followers];
      cc = options.cc ?? [];
      break;
    default: // direct
      to = options.to ?? [];
      cc = options.cc ?? [];
  }

  const note: APNote = {
    "@context": DEFAULT_CONTEXT,
    id: noteId,
    type: "Note",
    attributedTo: actorId,
    content: options.content,
    published: options.published,
    updated: options.published,
    to,
    cc,
    url: noteId,
    sensitive: options.sensitive ?? false,
    replies: {
      id: `${noteId}/replies`,
      type: "Collection",
      first: {
        id: `${noteId}/replies?page=true`,
        type: "CollectionPage",
        partOf: `${noteId}/replies`,
        items: [],
      },
    },
  };

  if (options.inReplyTo) note.inReplyTo = options.inReplyTo;
  if (options.sensitive && options.summary) note.summary = options.summary;
  if (options.language) note.contentMap = { [options.language]: options.content };

  return note;
}

// ─────────────────────────────────────────
// Activity builders
// ─────────────────────────────────────────

export function buildCreate(baseUrl: string, actorId: string, note: APNote, id: string): APActivity {
  return {
    "@context": DEFAULT_CONTEXT,
    id: activityIRI(baseUrl, id),
    type: "Create",
    actor: actorId,
    published: note.published,
    to: note.to,
    cc: note.cc,
    object: note,
  };
}

export function buildFollow(baseUrl: string, actorId: string, targetId: string, id: string): APActivity {
  return {
    "@context": DEFAULT_CONTEXT,
    id: activityIRI(baseUrl, id),
    type: "Follow",
    actor: actorId,
    object: targetId,
    to: [targetId],
  };
}

export function buildAccept(baseUrl: string, actorId: string, followActivity: APActivity, id: string): APActivity {
  return {
    "@context": DEFAULT_CONTEXT,
    id: activityIRI(baseUrl, id),
    type: "Accept",
    actor: actorId,
    object: followActivity,
    to: [typeof followActivity.actor === "string" ? followActivity.actor : followActivity.actor.id],
  };
}

export function buildReject(baseUrl: string, actorId: string, followActivity: APActivity, id: string): APActivity {
  return {
    "@context": DEFAULT_CONTEXT,
    id: activityIRI(baseUrl, id),
    type: "Reject",
    actor: actorId,
    object: followActivity,
    to: [typeof followActivity.actor === "string" ? followActivity.actor : followActivity.actor.id],
  };
}

export function buildUndo(baseUrl: string, actorId: string, activity: APActivity, id: string): APActivity {
  return {
    "@context": DEFAULT_CONTEXT,
    id: activityIRI(baseUrl, id),
    type: "Undo",
    actor: actorId,
    object: activity,
    to: activity.to ?? [PUBLIC_ADDRESS],
    cc: activity.cc,
  };
}

export function buildLike(baseUrl: string, actorId: string, objectId: string, id: string): APActivity {
  return {
    "@context": DEFAULT_CONTEXT,
    id: activityIRI(baseUrl, id),
    type: "Like",
    actor: actorId,
    object: objectId,
    to: [PUBLIC_ADDRESS],
  };
}

export function buildAnnounce(
  baseUrl: string,
  actorId: string,
  objectId: string,
  id: string,
  followers: string
): APActivity {
  return {
    "@context": DEFAULT_CONTEXT,
    id: activityIRI(baseUrl, id),
    type: "Announce",
    actor: actorId,
    object: objectId,
    published: new Date().toISOString(),
    to: [PUBLIC_ADDRESS],
    cc: [followers],
  };
}

export function buildDelete(baseUrl: string, actorId: string, objectId: string, id: string): APActivity {
  return {
    "@context": DEFAULT_CONTEXT,
    id: activityIRI(baseUrl, id),
    type: "Delete",
    actor: actorId,
    object: { id: objectId, type: "Tombstone" },
    to: [PUBLIC_ADDRESS],
    published: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────
// Collection builders
// ─────────────────────────────────────────

export function buildOrderedCollection(
  id: string,
  totalItems: number
): APCollection {
  return {
    "@context": DEFAULT_CONTEXT,
    id,
    type: "OrderedCollection",
    totalItems,
    first: `${id}?page=true`,
  };
}

export function buildOrderedCollectionPage(
  collectionId: string,
  items: unknown[],
  nextId?: string,
  prevId?: string
): APCollectionPage {
  const page: APCollectionPage = {
    "@context": DEFAULT_CONTEXT,
    id: `${collectionId}?page=true`,
    type: "OrderedCollectionPage",
    partOf: collectionId,
    orderedItems: items as APCollectionPage["orderedItems"],
  };
  if (nextId) page.next = nextId;
  if (prevId) page.prev = prevId;
  return page;
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

export function isPublic(activity: APActivity): boolean {
  const audiences = [...(activity.to ?? []), ...(activity.cc ?? [])];
  return audiences.includes(PUBLIC_ADDRESS);
}

export function extractDomain(url: string): string {
  return new URL(url).hostname;
}

export function isLocalIRI(iri: string, domain: string): boolean {
  try {
    return new URL(iri).hostname === domain;
  } catch {
    return false;
  }
}

export function extractUsername(actorId: string): string | null {
  const match = actorId.match(/\/users\/([^/]+)$/);
  return match ? match[1] : null;
}

// Collect all inbox recipients from activity audiences
export function getRecipientInboxes(
  to: string[],
  cc: string[],
  actorInbox: string
): string[] {
  return [...to, ...cc].filter(
    (addr) => addr !== PUBLIC_ADDRESS && addr !== actorInbox
  );
}
