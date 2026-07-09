// ActivityPub / ActivityStreams types

export interface APObject {
  "@context"?: string | string[] | Record<string, unknown>;
  id: string;
  type: string;
  [key: string]: unknown;
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

export interface APNote extends APObject {
  type: "Note";
  attributedTo: string;
  content: string;
  contentMap?: Record<string, string>;
  published: string;
  updated?: string;
  to: string[];
  cc?: string[];
  inReplyTo?: string;
  url?: string;
  sensitive?: boolean;
  summary?: string;
  attachment?: APAttachment[];
  tag?: APTag[];
  replies?: APCollection;
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
  name: string;
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
  object?: string | APObject | APActor | APNote;
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
  type: "mention" | "status" | "reblog" | "follow" | "follow_request" | "favourite" | "poll" | "update";
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
  configuration: {
    urls: { streaming: string };
    accounts: { max_featured_tags: number };
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
