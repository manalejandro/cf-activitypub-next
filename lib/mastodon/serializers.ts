/**
 * Mastodon API — serializers: convert local DB models to Mastodon API response shapes.
 */

import type {
  LocalActor,
  LocalObject,
  LocalNotification,
  MastodonAccount,
  MastodonStatus,
  MastodonNotification,
  MastodonInstance,
} from "@/lib/types";

// ─────────────────────────────────────────
// Account serializer
// ─────────────────────────────────────────

const DEFAULT_AVATAR = "/default-avatar.png";
const DEFAULT_HEADER = "/default-header.png";

export function serializeAccount(
  actor: LocalActor,
  localDomain: string,
  opts: { isCurrentUser?: boolean } = {}
): MastodonAccount {
  const isLocal = actor.isLocal;
  const acct = isLocal
    ? actor.username
    : `${actor.username}@${actor.domain}`;

  const account: MastodonAccount = {
    id: actor.id,
    username: actor.username,
    acct,
    display_name: actor.displayName ?? actor.username,
    locked: actor.manuallyApprovesFollowers,
    bot: actor.isBot,
    discoverable: actor.discoverable,
    created_at: actor.createdAt ?? new Date().toISOString(),
    note: actor.summary ?? "",
    url: isLocal ? `https://${localDomain}/@${actor.username}` : actor.id,
    uri: actor.id,
    avatar: actor.avatarUrl ?? DEFAULT_AVATAR,
    avatar_static: actor.avatarUrl ?? DEFAULT_AVATAR,
    header: actor.headerUrl ?? DEFAULT_HEADER,
    header_static: actor.headerUrl ?? DEFAULT_HEADER,
    followers_count: actor.followersCount,
    following_count: actor.followingCount,
    statuses_count: actor.statusesCount,
    last_status_at: null,
    emojis: [],
    fields: [],
  };

  if (opts.isCurrentUser) {
    account.source = {
      note: actor.summary ?? "",
      fields: [],
      privacy: "public",
      sensitive: false,
      language: null,
      follow_requests_count: 0,
    };
  }

  return account;
}

// ─────────────────────────────────────────
// Status serializer
// ─────────────────────────────────────────

export function serializeStatus(
  obj: LocalObject,
  author: LocalActor,
  localDomain: string,
  opts: { favourited?: boolean; reblogged?: boolean; reblogOf?: MastodonStatus } = {}
): MastodonStatus {
  const visibilityMap: Record<string, MastodonStatus["visibility"]> = {
    public: "public",
    unlisted: "unlisted",
    followers: "private",
    direct: "direct",
  };

  return {
    id: obj.id,
    created_at: obj.published,
    in_reply_to_id: obj.inReplyToId ?? null,
    in_reply_to_account_id: null,
    sensitive: obj.sensitive,
    spoiler_text: obj.contentWarning ?? "",
    visibility: visibilityMap[obj.visibility] ?? "public",
    language: obj.language ?? null,
    uri: obj.id,
    url: obj.url ?? obj.id,
    replies_count: obj.repliesCount,
    reblogs_count: obj.reblogsCount,
    favourites_count: obj.favouritesCount,
    edited_at: null,
    content: obj.content ?? "",
    reblog: opts.reblogOf ?? null,
    application: obj.local ? { name: "CF ActivityPub", website: `https://${localDomain}` } : null,
    account: serializeAccount(author, localDomain),
    media_attachments: [],
    mentions: [],
    tags: extractHashtags(obj.content ?? ""),
    emojis: [],
    card: null,
    poll: null,
    favourited: opts.favourited ?? false,
    reblogged: opts.reblogged ?? false,
    muted: false,
    bookmarked: false,
  };
}

// ─────────────────────────────────────────
// Notification serializer
// ─────────────────────────────────────────

export function serializeNotification(
  notif: LocalNotification,
  account: LocalActor,
  localDomain: string,
  status?: LocalObject,
  statusAuthor?: LocalActor
): MastodonNotification {
  const result: MastodonNotification = {
    id: notif.id,
    type: notif.type,
    created_at: notif.createdAt,
    account: serializeAccount(account, localDomain),
  };
  if (status && statusAuthor) {
    result.status = serializeStatus(status, statusAuthor, localDomain);
  }
  return result;
}

// ─────────────────────────────────────────
// Instance serializer
// ─────────────────────────────────────────

export function serializeInstanceV2(
  domain: string,
  title: string,
  description: string,
  version: string,
  userCount: number,
  contactAccount: MastodonAccount | null = null
): MastodonInstance {
  return {
    uri: domain,
    title,
    version: `${version} (compatible; Mastodon 4.3.0)`,
    source_url: "https://github.com/manalejandro/cf-activitypub-next",
    description,
    usage: { users: { active_month: userCount } },
    thumbnail: { url: `https://${domain}/logo.svg` },
    languages: ["en"],
    configuration: {
      urls: { streaming: `wss://${domain}` },
      accounts: { max_featured_tags: 10 },
      statuses: {
        max_characters: 500,
        max_media_attachments: 4,
        characters_reserved_per_url: 23,
      },
      media_attachments: {
        supported_mime_types: ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "audio/mpeg"],
        image_size_limit: 16 * 1024 * 1024,
        image_matrix_limit: 33_177_600,
        video_size_limit: 103_809_024,
        video_frame_rate_limit: 120,
        video_matrix_limit: 2_304_000,
      },
      polls: {
        max_options: 4,
        max_characters_per_option: 50,
        min_expiration: 300,
        max_expiration: 2_629_746,
      },
    },
    registrations: { enabled: true, approval_required: false, message: null },
    contact: { email: `admin@${domain}`, account: contactAccount },
    rules: [],
  };
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

function extractHashtags(content: string): { name: string; url: string }[] {
  const matches = content.match(/#([a-zA-Z0-9_]+)/g) ?? [];
  return matches.map((tag) => ({
    name: tag.slice(1).toLowerCase(),
    url: "",
  }));
}
