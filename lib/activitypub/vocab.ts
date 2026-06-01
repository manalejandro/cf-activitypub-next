// ActivityPub vocabulary constants

export const AS_CONTEXT = "https://www.w3.org/ns/activitystreams";
export const SECURITY_CONTEXT = "https://w3id.org/security/v1";
export const PUBLIC_ADDRESS = "https://www.w3.org/ns/activitystreams#Public";

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any[];

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

export const ACTOR_TYPES = [
  "Application",
  "Group",
  "Organization",
  "Person",
  "Service",
] as const;

export const OBJECT_TYPES = [
  "Article",
  "Audio",
  "Document",
  "Event",
  "Image",
  "Note",
  "Page",
  "Place",
  "Profile",
  "Relationship",
  "Tombstone",
  "Video",
] as const;
