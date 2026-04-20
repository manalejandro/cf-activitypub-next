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
  // computed for federation
  inbox?: string;
  outbox?: string;
  followers?: string;
  following?: string;
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

export interface LocalNotification {
  id: string;
  type: "mention" | "status" | "reblog" | "follow" | "follow_request" | "favourite" | "poll" | "update";
  accountId: string; // who triggered it
  targetAccountId: string; // who receives it
  objectId: string | null;
  read: boolean;
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
  appId: string;
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
  discoverable: boolean;
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
  emojis: MastodonEmoji[];
  fields: MastodonField[];
  source?: MastodonSource;
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
  card: null;
  poll: null;
  favourited: boolean;
  reblogged: boolean;
  muted: boolean;
  bookmarked: boolean;
  pinned?: boolean;
}

export interface MastodonAttachment {
  id: string;
  type: "image" | "gifv" | "video" | "audio" | "unknown";
  url: string;
  preview_url: string | null;
  remote_url: string | null;
  description: string | null;
  blurhash: string | null;
  meta?: Record<string, unknown>;
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

export interface MastodonSource {
  note: string;
  fields: MastodonField[];
  privacy: string;
  sensitive: boolean;
  language: string | null;
  follow_requests_count: number;
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
  };
  registrations: { enabled: boolean; approval_required: boolean; message: null };
  contact: { email: string; account: MastodonAccount | null };
  rules: { id: string; text: string; hint: string }[];
}
