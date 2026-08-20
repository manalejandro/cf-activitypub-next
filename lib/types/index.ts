// ActivityPub / ActivityStreams types

export interface APObject {
  "@context"?: string | string[] | Record<string, unknown>;
  id: string;
  type: string;
  [key: string]: unknown;
}

/** Type-specific metadata extracted from a remote ActivityStreams object. */
export interface APObjectMeta {
  /** Object title as a plain string (Article/Page/Note/Event name). */
  name?: string | null;
  /** Unix epoch millis for time-scoped objects (Event start). */
  startTime?: string | null;
  /** Unix epoch millis for time-scoped objects (Event end). */
  endTime?: string | null;
  /** Playback duration in seconds (Audio/Video/Page). */
  duration?: number | null;
  /** Human-readable location name (Place/Event). */
  location?: string | null;
  /** WGS84 latitude of the Place/Event. */
  latitude?: number | null;
  /** WGS84 longitude of the Place/Event. */
  longitude?: number | null;
  /** Author-facing display URL (resolved from obj.url or AP object id). */
  url?: string | null;
  /** Direct media file URL for top-level Audio/Video/Image objects. */
  mediaUrl?: string | null;
  /** Poster/preview thumbnail URL (resolved from the object's icon/image). */
  imageUrl?: string | null;
  /** Relationship: subject actor IRI (as:subject). */
  subject?: string | null;
  /** Relationship: object actor IRI (as:object). */
  relationshipObject?: string | null;
  /** Relationship: verb/relationship type IRI (as:relationship). */
  relationship?: string | null;
  /** Tombstone: former type of the deleted object (as:formerType). */
  formerType?: string | null;
  /** Tombstone: deletion timestamp (as:deleted). */
  deleted?: string | null;
  /** Collection: totalItems (as:totalItems). */
  totalItems?: number | null;
  /** Profile: the actor/entity the profile describes (as:describes). */
  describes?: string | null;
}

export interface APActor extends APObject {
  type: "Person" | "Service" | "Group" | "Organization" | "Application";
  preferredUsername: string;
  name?: string;
  summary?: string;
  url?: string;
  icon?: APImage;
  image?: APImage;
  inbox: string;
  outbox: string;
  followers: string;
  following: string;
  liked?: string;
  publicKey: APPublicKey;
  endpoints?: { sharedInbox?: string };
  manuallyApprovesFollowers?: boolean;
  discoverable?: boolean;
  indexable?: boolean;
  published?: string;
  alsoKnownAs?: string[];
  movedTo?: string;
  attachment?: APPropertyValue[];
  tag?: APTag[];
}

export interface APPublicKey {
  id: string;
  owner: string;
  publicKeyPem: string;
}

export interface APImage extends APObject {
  type: "Image";
  mediaType?: string;
  url: string;
  name?: string;
}

/**
 * A federated content object — any of the renderable ActivityStreams types.
 * Kept under the `APNote` name for compatibility with existing federation code,
 * but `type` may be any content-bearing object type (Note, Article, Page,
 * Video, Audio, Image, Event, Question, Place, Document, …).
 */
export interface APNote extends APObject {
  type: string;
  attributedTo?: string | APObject;
  content?: string;
  contentMap?: Record<string, string>;
  published?: string;
  updated?: string;
  to?: string[];
  cc?: string[];
  inReplyTo?: string;
  url?: string;
  sensitive?: boolean;
  summary?: string;
  name?: string;
  startTime?: string;
  endTime?: string;
  duration?: string | number;
  location?: string | APObject;
  latitude?: number;
  longitude?: number;
  attachment?: APAttachment[];
  tag?: APTag[];
  replies?: APCollection;
  oneOf?: APObject[];
  anyOf?: APObject[];
}

export interface APAttachment extends APObject {
  type: "Document" | "Image" | "Video" | "Audio";
  mediaType: string;
  url: string;
  name?: string;
  blurhash?: string;
  width?: number;
  height?: number;
}

export interface APTag {
  type: "Mention" | "Hashtag" | "Emoji";
  href?: string;
  name?: string;
  icon?: APImage;
  updated?: string;
}

export interface APPropertyValue {
  type: "PropertyValue";
  name: string;
  value: string;
}

export interface APCollection extends APObject {
  type: "Collection" | "OrderedCollection";
  totalItems?: number;
  first?: string | APCollectionPage;
  last?: string | APCollectionPage;
  items?: (string | APObject)[];
}

export interface APCollectionPage extends APObject {
  type: "CollectionPage" | "OrderedCollectionPage";
  partOf: string;
  next?: string;
  prev?: string;
  items?: (string | APObject)[];
  orderedItems?: (string | APObject)[];
}

export interface APActivity extends APObject {
  type: string;
  actor: string | APActor;
  object?: string | string[] | APObject | APActor | APNote;
  target?: string | APObject;
  to?: string[];
  cc?: string[];
  published?: string;
  id: string;
}

// Local DB types

export interface LocalActor {
  id: string;
  username: string;
  domain: string;
  displayName: string | null;
  summary: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  publicKeyPem: string;
  privateKeyPem: string | null; // null for remote actors
  isLocal: boolean;
  isBot: boolean;
  manuallyApprovesFollowers: boolean;
  discoverable: boolean;
  followersCount: number;
  followingCount: number;
  statusesCount: number;
  createdAt: string;
  updatedAt: string;
  // auth
  email: string | null;
  passwordHash: string | null;
  emailVerified: boolean;
  // moderation — populated when the query selects these columns
  role?: string;
  suspended?: boolean;
  silenced?: boolean;
  reserved?: boolean;
  // account migration
  alsoKnownAs?: string[] | null;
  movedTo?: string | null;
  // federation — stored for remote actors; computed for local
  inbox?: string;
  outbox?: string;
  followers?: string;
  following?: string;
  autoDeleteAfter: number | null;
}

export interface ActorField {
  id: string;
  actorId: string;
  name: string;
  value: string;
  position: number;
  createdAt: string;
}

export interface ObjectEdit {
  id: string;
  objectId: string;
  content: string | null;
  contentWarning: string | null;
  sensitive: boolean;
  raw: string;
  createdAt: string;
}

export interface LocalObject {
  id: string;
  type: string;
  actorId: string;
  content: string | null;
  contentWarning: string | null;
  sensitive: boolean;
  visibility: "public" | "unlisted" | "followers" | "direct";
  inReplyToId: string | null;
  language: string | null;
  url: string;
  repliesCount: number;
  reblogsCount: number;
  favouritesCount: number;
  published: string;
  updatedAt: string;
  local: boolean;
  raw: string; // JSON
}

export interface LocalFollow {
  id: string;
  actorId: string;
  targetId: string;
  state: "pending" | "accepted" | "rejected";
  activityId: string | null;
  createdAt: string;
}

/**
 * A cached KeyPackage of an actor (RFC 9420). Canonical for local actors
 * (backed by the actor's keyPackages collection); cached for remote actors
 * so the server can also serve the incoming direction.
 */
export interface LocalMlsKeyPackage {
  id: string;
  actorId: string;
  objectId: string;
  ciphersuite: string | null;
  mediaType: string | null;
  encoding: string | null;
  content: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A delivered MLS message envelope stored for a specific local recipient.
 * `type` is the ActivityPub activity type that carried it (Create/Add/Remove/
 * Delete), `objectType` is the MLS object type (PrivateMessage, Welcome, ...).
 * `raw` holds the full activity JSON so the web UI / a client can decrypt the
 * MLSTM envelope later without re-fetching.
 */
export interface LocalMlsMessage {
  id: string;
  type: string;
  actorId: string;
  recipientId: string;
  objectId: string | null;
  objectType: string | null;
  conversation: string | null;
  mediaType: string | null;
  encoding: string | null;
  content: string | null;
  raw: string; // JSON
  published: string;
  local: boolean;
  delivered: boolean;
}

export interface LocalLike {
  id: string;
  actorId: string;
  objectId: string;
  activityId: string;
  createdAt: string;
}

export interface LocalAnnounce {
  id: string;
  actorId: string;
  objectId: string;
  activityId: string;
  createdAt: string;
}

export interface LocalPoll {
  id: string;
  objectId: string;
  expiresAt: string;
  multiple: boolean;
  votesCount: number;
  votersCount: number;
  createdAt: string;
}

export interface LocalPollOption {
  id: string;
  pollId: string;
  title: string;
  votesCount: number;
  position: number;
}

export interface LocalNotification {
  id: string;
  type: "mention" | "status" | "reblog" | "follow" | "follow_request" | "favourite" | "poll" | "update" | "direct" | "encrypted";
  accountId: string; // who triggered it
  targetAccountId: string; // who receives it
  objectId: string | null;
  read: boolean;
  createdAt: string;
}

export interface LocalCustomEmoji {
  id: string;
  shortcode: string;
  url: string;
  staticUrl: string;
  category: string | null;
  visibleInPicker: boolean;
  domain: string | null;
  actorId: string | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocalAttachment {
  id: string;
  objectId: string;
  type: string;
  url: string;
  remoteUrl: string | null;
  description: string | null;
  blurhash: string | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
}

export interface OAuthApp {
  id: string;
  name: string;
  website: string | null;
  redirectUri: string;
  scopes: string;
  clientId: string;
  clientSecret: string;
  createdAt: string;
}

export interface OAuthToken {
  id: string;
  actorId: string | null;
  appId: string | null;
  accessToken: string;
  refreshToken: string | null;
  scope: string;
  createdAt: string;
  expiresAt: string | null;
}

/** A connection in the "authorized apps / sessions" list (no secrets). */
export interface AuthorizedAppConnection {
  id: string;
  actorId: string;
  appId: string | null;
  appName: string | null;
  appWebsite: string | null;
  scope: string;
  createdAt: string;
  expiresAt: string | null;
}

// Mastodon API types

export interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  locked: boolean;
  bot: boolean;
  group: boolean;
  discoverable: boolean;
  indexable: boolean;
  noindex: boolean;
  created_at: string;
  note: string;
  url: string;
  uri: string;
  avatar: string;
  avatar_static: string;
  header: string;
  header_static: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  last_status_at: string | null;
  hide_collections: boolean | null;
  emojis: MastodonEmoji[];
  fields: MastodonField[];
  roles: MastodonRole[];
  moved?: MastodonAccount | null;
  suspended?: boolean;
  limited?: boolean;
  memorial?: boolean;
  source?: MastodonSource;
  supports_calls?: boolean;
}

export interface MastodonStatus {
  id: string;
  created_at: string;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  sensitive: boolean;
  spoiler_text: string;
  visibility: "public" | "unlisted" | "private" | "direct";
  language: string | null;
  uri: string;
  url: string | null;
  replies_count: number;
  reblogs_count: number;
  favourites_count: number;
  edited_at: string | null;
  content: string;
  reblog: MastodonStatus | null;
  application: { name: string; website: string | null } | null;
  account: MastodonAccount;
  media_attachments: MastodonAttachment[];
  mentions: MastodonMention[];
  tags: MastodonTag[];
  emojis: MastodonEmoji[];
  card: MastodonPreviewCard | null;
  poll: MastodonPoll | null;
  filtered: MastodonFilterResult[];
  quotes_count: number;
  quote: MastodonQuote | null;
  favourited: boolean;
  reblogged: boolean;
  muted: boolean;
  bookmarked: boolean;
  pinned?: boolean;
  /**
   * The underlying ActivityStreams object type (e.g. "Note", "Article",
   * "Event", "Video", "Audio", "Image", "Place", "Page", "Question").
   * Always present for locally-sourced statuses; used by the UI to render
   * type-specific blocks. Null/absent for legacy non-Note shapes.
   */
  ap_type?: string | null;
  /** Type-specific metadata (title, time range, place, duration, links). */
  ap_meta?: APObjectMeta | null;
}

export interface MastodonPoll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number;
  voted: boolean;
  own_votes: number[];
  options: { title: string; votes_count: number | null }[];
  emojis: MastodonEmoji[];
}

export interface MastodonAttachment {
  id: string;
  type: "image" | "gifv" | "video" | "audio" | "unknown";
  url: string;
  preview_url: string | null;
  remote_url: string | null;
  text_url: string | null;
  description: string | null;
  blurhash: string | null;
  meta?: MastodonAttachmentMeta;
}

export interface MastodonAttachmentMeta {
  original?: {
    width?: number;
    height?: number;
    size?: string;
    aspect?: number;
    duration?: number;
    bitrate?: number;
    frame_rate?: string;
  };
  small?: {
    width?: number;
    height?: number;
    size?: string;
    aspect?: number;
  };
  focus?: { x: number; y: number };
  colors?: { accent?: string; background?: string; foreground?: string };
}

export interface MastodonPreviewCard {
  url: string;
  title: string;
  description: string;
  type: "link" | "photo" | "video" | "rich";
  author_name: string;
  author_url: string;
  provider_name: string;
  provider_url: string;
  html: string;
  width: number;
  height: number;
  image: string | null;
  image_description: string;
  embed_url: string;
  blurhash: string | null;
  language: string | null;
  published_at: string | null;
  authors: { name: string; url: string; account: MastodonAccount | null }[];
}

export interface MastodonRole {
  id: string;
  name: string;
  color: string;
}

export interface MastodonFilter {
  id: string;
  title: string;
  context: string[];
  expires_at: string | null;
  filter_action: "warn" | "hide";
}

export interface MastodonFilterResult {
  filter: MastodonFilter;
  keyword_matches: string[] | null;
  status_matches: string[] | null;
}

export interface MastodonQuote {
  quoted_status_id: string | null;
  state: string;
}

export interface MastodonMention {
  id: string;
  username: string;
  url: string;
  acct: string;
}

export interface MastodonTag {
  name: string;
  url: string;
}

export interface MastodonEmoji {
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker: boolean;
}

export interface MastodonField {
  name: string;
  value: string;
  verified_at: string | null;
}

export interface MastodonPreferences {
  "posting:default:visibility": string;
  "posting:default:sensitive": boolean;
  "posting:default:language": string | null;
  "posting:default:quote_policy": string;
  "reading:expand:media": string;
  "reading:expand:spoilers": boolean;
}

export interface MastodonMarker {
  last_read_id: string;
  version: number;
  updated_at: string;
}

export interface MastodonWebPushSubscription {
  id: string;
  endpoint: string;
  standard: boolean;
  alerts: Record<string, boolean>;
  server_key: string;
}

export interface LocalMarker {
  id: string;
  actorId: string;
  timeline: string;
  lastReadId: string;
  version: number;
  updatedAt: string;
}

export interface LocalPushSubscription {
  id: string;
  actorId: string;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  standard: boolean;
  policy: string;
  alerts: string;
  serverKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface MastodonSource {
  note: string;
  fields: MastodonField[];
  privacy: string;
  sensitive: boolean;
  language: string | null;
  follow_requests_count: number;
  auto_delete_after: number | null;
}

export interface MastodonNotification {
  id: string;
  type: string;
  created_at: string;
  account: MastodonAccount;
  status?: MastodonStatus;
}

export interface MastodonInstance {
  uri: string;
  title: string;
  version: string;
  source_url: string;
  description: string;
  usage: { users: { active_month: number } };
  thumbnail: { url: string };
  languages: string[];
  vapid_public_key?: string;
  configuration: {
    urls: { streaming: string };
    accounts: { max_featured_tags: number };
    vapid?: { secret_key: string };
    statuses: {
      max_characters: number;
      max_media_attachments: number;
      characters_reserved_per_url: number;
    };
    media_attachments: {
      supported_mime_types: string[];
      image_size_limit: number;
      image_matrix_limit: number;
      video_size_limit: number;
      video_frame_rate_limit: number;
      video_matrix_limit: number;
    };
    polls: { max_options: number; max_characters_per_option: number; min_expiration: number; max_expiration: number };
    calls?: { enabled: boolean };
  };
  registrations: { enabled: boolean; approval_required: boolean; message: null };
  contact: { email: string; account: MastodonAccount | null };
  rules: { id: string; text: string; hint: string }[];
}

// ─────────────────────────────────────────
// Additional Mastodon API types
// ─────────────────────────────────────────

export interface MastodonConversation {
  id: string;
  unread: boolean;
  accounts: MastodonAccount[];
  last_status: MastodonStatus | null;
}

export interface MastodonList {
  id: string;
  title: string;
  replies_policy: string;
  exclusive: boolean;
}

export interface MastodonFilterV2 {
  id: string;
  title: string;
  context: string[];
  expires_at: string | null;
  filter_action: string;
  keywords: { id: string; keyword: string; whole_word: boolean }[];
  statuses: { id: string; status_id: string }[];
}

export interface MastodonFilterKeyword {
  id: string;
  keyword: string;
  whole_word: boolean;
}

export interface MastodonFilterStatus {
  id: string;
  status_id: string;
}

export interface MastodonScheduledStatus {
  id: string;
  scheduled_at: string;
  params: {
    text: string | null;
    poll: Record<string, unknown> | null;
    media_ids: string[] | null;
    sensitive: boolean | null;
    spoiler_text: string | null;
    visibility: string | null;
    in_reply_to_id: string | null;
    language: string | null;
    application_id: number | null;
    scheduled_at: null;
    idempotency: string | null;
    with_rate_limit: boolean;
  };
  media_attachments: MastodonAttachment[];
}

export interface MastodonReport {
  id: string;
  action_taken: boolean;
  action_taken_at: string | null;
  category: string;
  comment: string;
  forwarded: boolean;
  created_at: string;
  status_ids: string[] | null;
  rule_ids: string[] | null;
  target_account: MastodonAccount;
}

export interface MastodonFeaturedTag {
  id: string;
  name: string;
  url: string;
  statuses_count: number;
  last_status_at: string | null;
}

export interface MastodonSuggestion {
  source: string;
  account: MastodonAccount;
}

export interface MastodonAnnouncement {
  id: string;
  content: string;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  published_at: string;
  updated_at: string;
  read: boolean;
  mentions: { id: string; username: string; url: string; acct: string }[];
  statuses: { id: string; url: string }[];
  tags: { name: string; url: string }[];
  emojis: MastodonEmoji[];
  reactions: { name: string; count: number; me: boolean; url: string; static_url: string }[];
}

export interface MastodonProfile {
  id: string;
  display_name: string;
  note: string;
  fields: MastodonField[];
  avatar: string;
  avatar_static: string;
  avatar_description: string;
  header: string;
  header_static: string;
  header_description: string;
  locked: boolean;
  bot: boolean;
  hide_collections: boolean;
  discoverable: boolean;
  indexable: boolean;
  show_media: boolean;
  show_media_replies: boolean;
  show_featured: boolean;
  attribution_domains: string[];
  featured_tags: MastodonFeaturedTag[];
}
