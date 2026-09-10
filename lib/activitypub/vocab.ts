// ActivityPub vocabulary constants — full ActivityStreams 2.0 vocabulary.

export const AS_CONTEXT = "https://www.w3.org/ns/activitystreams";
export const SECURITY_CONTEXT = "https://w3id.org/security/v1";
export const PUBLIC_ADDRESS = "https://www.w3.org/ns/activitystreams#Public";

/** The 28 Activity activity types (idioms + extended) defined by AS 2.0. */
export const ACTIVITY_TYPES = [
  "Accept",
  "Add",
  "Announce",
  "Arrive",
  "Block",
  "Create",
  "Delete",
  "Dislike",
  "Flag",
  "Follow",
  "Ignore",
  "Invite",
  "Join",
  "Leave",
  "Like",
  "Listen",
  "Move",
  "Offer",
  "Question",
  "Reject",
  "Read",
  "Remove",
  "TentativeReject",
  "TentativeAccept",
  "Travel",
  "Undo",
  "Update",
  "View",
] as const;

/** The 5 Actor types defined by AS 2.0 (extended by Akkoma/Misskey with "User"). */
export const ACTOR_TYPES = [
  "Application",
  "Group",
  "Organization",
  "Person",
  "Service",
] as const;

/** All Object types defined in the AS 2.0 core + extended vocabulary. */
export const OBJECT_TYPES = [
  // core
  "Object",
  "Relation",
  // extended objects
  "Article",
  "Audio",
  "Collection",
  "CollectionPage",
  "Document",
  "Event",
  "Image",
  "OrderedCollection",
  "OrderedCollectionPage",
  "Place",
  "Profile",
  "Relationship",
  "Tombstone",
  "Video",
  // primitives / actors
  "Note",
  "Page",
  "Question",
  "Application",
  "Group",
  "Organization",
  "Person",
  "Service",
  // links
  "Mention",
] as const;

/**
 * MLS (Messaging Layer Security, RFC 9420) object types federated over
 * ActivityPub per the "Messaging Layer Security in ActivityPub" draft.
 * These carry ciphertext envelopes (MLSTM/MLSMessage) — the server never
 * decrypts them, it only delivers and stores the envelopes.
 */
export const MLS_OBJECT_TYPES = [
  "KeyPackage",
  "Welcome",
  "GroupInfo",
  "PrivateMessage",
  "PublicMessage",
] as const;

export type MlsObjectType = (typeof MLS_OBJECT_TYPES)[number];

/**
 * JSON-LD context declaring the MLS vocabulary. Servers/clients that want to
 * cryptographically verify types should dereference the canonical context.
 */
export const MLS_CONTEXT = "https://purl.archive.org/socialweb/mls";

const MLS_SET = new Set<string>(MLS_OBJECT_TYPES);

export function isMlsObjectType(type: string): boolean {
  return MLS_SET.has(type);
}

/**
 * Resolve the MLS object type out of a `type` field that may be a plain string
 * (`"PrivateMessage"`), a namespaced string (`"mls:PrivateMessage"`), or an
 * array like `["Object", "PrivateMessage"]` (as the draft's examples use).
 * Returns the first recognized MLS type, or null.
 */
export function mlsObjectTypeFromType(type: unknown): string | null {
  const candidates = Array.isArray(type) ? type : [type];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const last = c.split("/").pop() ?? "";
    if (MLS_SET.has(last)) return last;
  }
  return null;
}

/**
 * Object types that carry user-rendered content and are surfaced on timelines
 * as a first-class "status", mirroring how Mastodon federates Article/Page/Video
 * etc. as rich posts. Everything here is stored as a LocalObject row.
 */
export const CONTENT_OBJECT_TYPES = [
  "Article",
  "Audio",
  "Document",
  "Event",
  "Image",
  "Note",
  "Page",
  "Place",
  "Question",
  "Video",
] as const;

export type ContentObjectType = (typeof CONTENT_OBJECT_TYPES)[number];

/** Object types that embed a media payload as their primary presentation. */
export const MEDIA_OBJECT_TYPES = ["Audio", "Image", "Video"] as const;

/** Object types with a scheduled time dimension (Event). */
export const TIME_OBJECT_TYPES = ["Event"] as const;

/**
 * Object types the UI can render as a dedicated block (APTypeBlock). Broader
 * than CONTENT_OBJECT_TYPES: includes social-graph and structural types that
 * occasionally surface as standalone objects (Profile, Relationship,
 * Tombstone, Collection) but still need a meaningful presentation.
 */
export const RENDERABLE_OBJECT_TYPES = [
  ...CONTENT_OBJECT_TYPES,
  "Profile",
  "Relationship",
  "Tombstone",
  "Collection",
  "OrderedCollection",
  "PublicMessage",
] as const;

export type RenderableObjectType = (typeof RENDERABLE_OBJECT_TYPES)[number];

const ACTIVITY_SET = new Set<string>(ACTIVITY_TYPES);
const ACTOR_SET = new Set<string>(ACTOR_TYPES);
const OBJECT_SET = new Set<string>(OBJECT_TYPES);
const CONTENT_SET = new Set<string>(CONTENT_OBJECT_TYPES);
const RENDERABLE_SET = new Set<string>(RENDERABLE_OBJECT_TYPES);

export function isActivityType(type: string): boolean {
  return ACTIVITY_SET.has(type);
}

export function isActorType(type: string): boolean {
  return ACTOR_SET.has(type);
}

export function isObjectType(type: string): boolean {
  return OBJECT_SET.has(type);
}

/** Whether a remote object type should be ingested and rendered as a status. */
export function isContentObjectType(type: string): boolean {
  return CONTENT_SET.has(type) || CONTENT_SET.has(type.toLowerCase());
}

/** Whether the UI has a dedicated renderer block for the given object type. */
export function isRenderableObjectType(type: string): boolean {
  return RENDERABLE_SET.has(type);
}

/** Full Mastodon-compatible context — required for PropertyValue fields,
 *  toot: extensions (discoverable, indexable, etc.) and schema.org terms. */
export const DEFAULT_CONTEXT = [
  AS_CONTEXT,
  SECURITY_CONTEXT,
  {
    manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
    toot: "http://joinmastodon.org/ns#",
    featured:     { "@id": "toot:featured",     "@type": "@id" },
    featuredTags: { "@id": "toot:featuredTags", "@type": "@id" },
    alsoKnownAs:  { "@id": "as:alsoKnownAs",   "@type": "@id" },
    movedTo:      { "@id": "as:movedTo",        "@type": "@id" },
    schema:        "http://schema.org#",
    PropertyValue: "schema:PropertyValue",
    value:         "schema:value",
    discoverable:  "toot:discoverable",
    indexable:     "toot:indexable",
    suspended:     "toot:suspended",
    memorial:      "toot:memorial",
    Hashtag:       "as:Hashtag",
    Emoji:         "toot:Emoji",
    focalPoint:    { "@container": "@list", "@id": "toot:focalPoint" },
  },
  // MLS (Messaging Layer Security) over ActivityPub — see MLS_CONTEXT.
  {
    mls: "https://purl.archive.org/socialweb/mls#",
    keyPackages: { "@id": "mls:keyPackages", "@type": "@id" },
    messages:    { "@id": "mls:messages",    "@type": "@id" },
    encoding:    "mls:encoding",
    conversation: "mls:conversation",
    ciphersuite: "mls:ciphersuite",
    KeyPackage:   { "@id": "mls:KeyPackage",   "@type": "@id" },
    Welcome:      { "@id": "mls:Welcome",      "@type": "@id" },
    GroupInfo:    { "@id": "mls:GroupInfo",    "@type": "@id" },
    PublicMessage:   { "@id": "mls:PublicMessage",   "@type": "@id" },
    PrivateMessage:  { "@id": "mls:PrivateMessage",  "@type": "@id" },
  },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any[];
