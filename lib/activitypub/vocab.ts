// ActivityPub vocabulary constants

export const AS_CONTEXT = "https://www.w3.org/ns/activitystreams";
export const SECURITY_CONTEXT = "https://w3id.org/security/v1";
export const PUBLIC_ADDRESS = "https://www.w3.org/ns/activitystreams#Public";

export const DEFAULT_CONTEXT = [AS_CONTEXT, SECURITY_CONTEXT];

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
