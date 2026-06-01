/**
 * Mastodon API — serializers: convert local DB models to Mastodon API response shapes.
 */

import type {
  LocalActor,
  ActorField,
  LocalObject,
  LocalNotification,
  LocalAttachment,
  LocalPoll,
  LocalPollOption,
  MastodonAccount,
  MastodonAttachment,
  MastodonPoll,
  MastodonStatus,
  MastodonNotification,
  MastodonInstance,
} from "@/lib/types";
import { encodeStatusId } from "@/lib/mastodon/statusId";

// ─────────────────────────────────────────
// Account serializer
// ─────────────────────────────────────────

const DEFAULT_AVATAR = "/default-avatar.png";
const DEFAULT_HEADER = "/default-header.png";

export function serializeAccount(
  actor: LocalActor,
  localDomain: string,
  opts: { isCurrentUser?: boolean; fields?: ActorField[] } = {}
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
    url: isLocal ? `https://${localDomain}/users/${actor.username}` : actor.id,
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
    fields: (opts.fields ?? []).map((f) => ({
      name: f.name,
      value: f.value,
      verified_at: null,
    })),
  };

  if (opts.isCurrentUser) {
    account.source = {
      note: (actor.summary ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""),
      // Plain-text version for edit textarea: strip HTML tags
      fields: (opts.fields ?? []).map((f) => ({
        name: f.name,
        value: f.value,
        verified_at: null,
      })),
      privacy: "public",
      sensitive: false,
      language: null,
      follow_requests_count: 0,
      auto_delete_after: actor.autoDeleteAfter ?? null,
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
  opts: { favourited?: boolean; reblogged?: boolean; reblogOf?: MastodonStatus; attachments?: LocalAttachment[]; poll?: MastodonPoll | null } = {}
): MastodonStatus {
  const visibilityMap: Record<string, MastodonStatus["visibility"]> = {
    public: "public",
    unlisted: "unlisted",
    followers: "private",
    direct: "direct",
  };

  return {
    id: encodeStatusId(obj.id, obj.local),
    created_at: obj.published,
    in_reply_to_id: obj.inReplyToId
      ? encodeStatusId(
          obj.inReplyToId,
          obj.inReplyToId.startsWith(`https://${localDomain}/objects/`)
        )
      : null,
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
    edited_at: obj.updatedAt && obj.updatedAt !== obj.published ? obj.updatedAt : null,
    content: obj.content ?? "",
    reblog: opts.reblogOf ?? null,
    application: obj.local ? { name: "CF ActivityPub", website: `https://${localDomain}` } : null,
    account: serializeAccount(author, localDomain),
    media_attachments: (opts.attachments ?? []).map(serializeAttachment),
    mentions: [],
    tags: extractHashtags(obj.content ?? ""),
    emojis: [],
    card: null,
    poll: opts.poll ?? null,
    favourited: opts.favourited ?? false,
    reblogged: opts.reblogged ?? false,
    muted: false,
    bookmarked: false,
  };
}

// ─────────────────────────────────────────
// Poll serializer
// ─────────────────────────────────────────

export function serializePoll(
  poll: LocalPoll,
  options: LocalPollOption[],
  voted: boolean,
  ownVotes: number[]
): MastodonPoll {
  const now = new Date();
  const expired = now > new Date(poll.expiresAt);
  return {
    id: poll.id,
    expires_at: poll.expiresAt,
    expired,
    multiple: poll.multiple,
    votes_count: poll.votesCount,
    voters_count: poll.votersCount,
    voted,
    own_votes: ownVotes,
    options: options.map((opt) => ({
      title: opt.title,
      votes_count: voted || expired ? opt.votesCount : null,
    })),
    emojis: [],
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

function serializeAttachment(att: LocalAttachment): MastodonAttachment {
  const mimeToType = (mime: string | null): MastodonAttachment["type"] => {
    if (!mime) return "unknown";
    if (mime.startsWith("image/gif")) return "gifv";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "unknown";
  };
  return {
    id: att.id,
    type: mimeToType(att.mimeType),
    url: att.url,
    preview_url: att.url,
    remote_url: att.remoteUrl ?? null,
    description: att.description ?? null,
    blurhash: att.blurhash ?? null,
    meta: att.width && att.height
      ? { original: { width: att.width, height: att.height } }
      : undefined,
  };
}

function extractHashtags(content: string): { name: string; url: string }[] {
  const matches = content.match(/#([a-zA-Z0-9_]+)/g) ?? [];
  return matches.map((tag) => ({
    name: tag.slice(1).toLowerCase(),
    url: "",
  }));
}
