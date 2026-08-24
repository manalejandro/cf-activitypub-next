/**
 * Mastodon API — serializers: convert local DB models to Mastodon API response shapes.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type {
  LocalActor,
  ActorField,
  LocalObject,
  LocalNotification,
  LocalAttachment,
  LocalPoll,
  LocalPollOption,
  LocalCustomEmoji,
  LocalCollectionItem,
  MastodonAccount,
  MastodonAttachment,
  MastodonAttachmentMeta,
  MastodonPoll,
  MastodonStatus,
  MastodonNotification,
  MastodonInstance,
  MastodonMention,
  MastodonCollection,
  APTag,
  APObject,
  APObjectMeta,
} from "@/lib/types";
import { encodeStatusId } from "@/lib/mastodon/statusId";
import { sanitizeFediverseHtml, sanitizeFediversePlain } from "@/lib/activitypub/sanitize";
import { isRenderableObjectType } from "@/lib/activitypub/vocab";
import { linkifyHtmlText, linkifyInline, localSummaryToPlain, processStatusContent } from "@/lib/activitypub/content";

// ─────────────────────────────────────────
// Account serializer
// ─────────────────────────────────────────

const DEFAULT_AVATAR = "/default-avatar.png";
const DEFAULT_HEADER = "/default-header.png";

/**
 * Normalize any stored timestamp to RFC 3339 (ISO 8601 with Z).
 * SQLite's `datetime('now')` produces "YYYY-MM-DD HH:MM:SS" which JS `new Date()`
 * parses inconsistently across engines — Mastodon clients require ISO.
 */
function toIso(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(" ", "T")}Z`;
  try {
    return new Date(s).toISOString();
  } catch {
    return null;
  }
}

function serializeEmoji(e: LocalCustomEmoji): { shortcode: string; url: string; static_url: string; visible_in_picker: boolean; category?: string } {
  return {
    shortcode: e.shortcode,
    url: e.url,
    static_url: e.staticUrl,
    visible_in_picker: e.visibleInPicker,
    ...(e.category ? { category: e.category } : {}),
  };
}

/**
 * Only the custom emojis whose shortcode actually appears in the given content.
 * Mastodon's `emojis` field on a status/account lists just the emojis used there
 * (so the client can render them), never the whole instance emoji set.
 */
function filterUsedEmojis(contents: (string | null | undefined)[], emojis: LocalCustomEmoji[]): LocalCustomEmoji[] {
  if (emojis.length === 0) return [];
  const haystack = contents.filter((c): c is string => typeof c === "string" && c.length > 0).join(" ");
  if (!haystack) return [];
  return emojis.filter((e) => haystack.includes(`:${e.shortcode}:`));
}

export function serializeAccount(
  actor: LocalActor,
  localDomain: string,
  opts: { isCurrentUser?: boolean; fields?: ActorField[]; emojis?: LocalCustomEmoji[]; supportsCalls?: boolean; role?: string; lastStatusAt?: string | null; moved?: MastodonAccount | null } = {}
): MastodonAccount {
  const isLocal = actor.isLocal;
  const acct = isLocal
    ? actor.username
    : `${actor.username}@${actor.domain}`;

  const baseUrl = `https://${localDomain}`;

  // Local actors store plain-text notes/fields, so linkify them the same way
  // statuses are. Remote actors already carry federated HTML.
  const note = isLocal
    ? linkifyInline(localSummaryToPlain(actor.summary ?? ""), baseUrl, opts.emojis)
    : sanitizeFediverseHtml(actor.summary ?? "") ?? "";

  const account: MastodonAccount = {
    id: actor.id,
    username: actor.username,
    acct,
    display_name: actor.displayName ?? actor.username,
    locked: actor.manuallyApprovesFollowers,
    bot: actor.isBot,
    group: false,
    discoverable: actor.discoverable,
    indexable: actor.discoverable,
    noindex: !actor.discoverable,
    created_at: toIso(actor.createdAt) ?? new Date().toISOString(),
    note,
    url: isLocal ? `https://${localDomain}/users/${actor.username}` : actor.id,
    uri: actor.id,
    avatar: actor.avatarUrl ?? `https://${localDomain}${DEFAULT_AVATAR}`,
    avatar_static: actor.avatarUrl ?? `https://${localDomain}${DEFAULT_AVATAR}`,
    header: actor.headerUrl ?? `https://${localDomain}${DEFAULT_HEADER}`,
    header_static: actor.headerUrl ?? `https://${localDomain}${DEFAULT_HEADER}`,
    followers_count: actor.followersCount,
    following_count: actor.followingCount,
    statuses_count: actor.statusesCount,
    last_status_at: opts.lastStatusAt ?? null,
    hide_collections: null,
    emojis: filterUsedEmojis(
      [actor.displayName, actor.summary, ...(opts.fields ?? []).map((f) => f.name), ...(opts.fields ?? []).map((f) => f.value)],
      opts.emojis ?? []
    ).map(serializeEmoji),
    roles: opts.role ? [{ id: opts.role === "admin" ? "1" : opts.role === "moderator" ? "2" : "3", name: opts.role.charAt(0).toUpperCase() + opts.role.slice(1), color: "" }] : (actor.isLocal && (actor.role === "admin" || actor.role === "moderator")) ? [{ id: actor.role === "admin" ? "1" : "2", name: actor.role.charAt(0).toUpperCase() + actor.role.slice(1), color: "" }] : [],
    fields: (opts.fields ?? []).map((f) => ({
      name: sanitizeFediversePlain(f.name) ?? f.name,
      value: isLocal
        ? linkifyInline(f.value, baseUrl, opts.emojis)
        : sanitizeFediverseHtml(f.value) ?? f.value,
      verified_at: null,
    })),
  };

  account.supports_calls = opts.supportsCalls ?? isLocal;

  // Moderation state — Mastodon clients use these to render silence/suspension.
  if (actor.suspended) account.suspended = true;
  if (actor.silenced) account.limited = true;
  if (opts.moved) account.moved = opts.moved;

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
      bot: actor.isBot,
      follow_requests_count: 0,
      auto_delete_after: actor.autoDeleteAfter ?? null,
    };
  }

  return account;
}

// ─────────────────────────────────────────
// Collection serializer
// ─────────────────────────────────────────

/** Structurally matches the collections row shape returned by lib/db. */
export interface CollectionInput {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  language: string | null;
  tag_name: string | null;
  sensitive: number;
  discoverable: number;
  local: number;
  created_at: string;
  updated_at: string;
  item_count: number;
}

export function serializeCollection(
  col: CollectionInput,
  localDomain: string,
  items: LocalCollectionItem[] = []
): MastodonCollection {
  const baseUrl = `https://${localDomain}`;
  const tagName = col.tag_name ? col.tag_name.replace(/^#/, "") : null;
  return {
    id: col.id,
    account_id: col.account_id,
    uri: `${baseUrl}/collections/${col.id}`,
    url: `${baseUrl}/collections/${col.id}`,
    name: col.name,
    description: col.description,
    language: col.language,
    local: Boolean(col.local),
    sensitive: Boolean(col.sensitive),
    discoverable: Boolean(col.discoverable),
    tag: tagName ? { name: tagName, url: `${baseUrl}/tags/${encodeURIComponent(tagName)}` } : null,
    item_count: col.item_count,
    items: items.map((i) => ({
      id: i.id,
      account_id: i.accountId,
      state: i.state,
      created_at: toIso(i.createdAt) ?? i.createdAt,
    })),
    created_at: toIso(col.created_at) ?? col.created_at,
    updated_at: toIso(col.updated_at) ?? col.updated_at,
  };
}

/**
 * Render federated status content for display.
 *
 * Servers that emit fully-linked HTML (Mastodon, GoToSocial, Akkoma) pass
 * through the sanitizer unchanged. Many others (PeerTube, WordPress, some
 * bridges) send plain text with no markup, or wrap unlinked plain text in
 * `<p>` tags — for those, linkify URLs, @mentions, #hashtags and :emoji:
 * shortcodes just like locally-authored posts so links render instead of raw
 * text.
 */
function renderRemoteContent(
  content: string | null | undefined,
  localDomain: string,
  emojis?: LocalCustomEmoji[]
): string {
  const raw = content ?? "";
  if (!raw) return "";
  const isHtml = /<[a-z][\s>]/i.test(raw);
  if (isHtml) {
    const sanitized = sanitizeFediverseHtml(raw) ?? "";
    return linkifyHtmlText(sanitized, `https://${localDomain}`, emojis);
  }
  return processStatusContent(localSummaryToPlain(raw), `https://${localDomain}`, emojis).html;
}

export function serializeStatus(
  obj: LocalObject,
  author: LocalActor,
  localDomain: string,
  opts: { favourited?: boolean; reblogged?: boolean; reblogOf?: MastodonStatus; attachments?: LocalAttachment[]; poll?: MastodonPoll | null; emojis?: LocalCustomEmoji[]; pinned?: boolean; inReplyToAccountId?: string | null } = {}
): MastodonStatus {
  const visibilityMap: Record<string, MastodonStatus["visibility"]> = {
    public: "public",
    unlisted: "unlisted",
    followers: "private",
    direct: "direct",
  };

  return {
    id: encodeStatusId(obj.id, obj.local),
    created_at: toIso(obj.published) ?? new Date().toISOString(),
    in_reply_to_id: obj.inReplyToId
      ? encodeStatusId(
          obj.inReplyToId,
          obj.inReplyToId.startsWith(`https://${localDomain}/objects/`)
        )
      : null,
    in_reply_to_account_id: opts.inReplyToAccountId ?? null,
    sensitive: obj.sensitive,
    spoiler_text: sanitizeFediversePlain(obj.contentWarning ?? "") ?? "",
    visibility: visibilityMap[obj.visibility] ?? "public",
    language: obj.language ?? null,
    uri: obj.id,
    url: obj.url ?? obj.id,
    replies_count: obj.repliesCount,
    reblogs_count: obj.reblogsCount,
    favourites_count: obj.favouritesCount,
    edited_at: obj.updatedAt && obj.updatedAt !== obj.published ? toIso(obj.updatedAt) : null,
    content: rewriteProfileLinks(renderRemoteContent(obj.content, localDomain, opts.emojis), obj.raw, localDomain),
    reblog: opts.reblogOf ?? null,
    application: obj.local ? { name: "CF ActivityPub", website: `https://${localDomain}` } : null,
    account: serializeAccount(author, localDomain),
    media_attachments: (opts.attachments ?? []).map(serializeAttachment),
    mentions: extractMentionsFromRaw(obj.raw, localDomain),
    tags: extractHashtags(obj.content ?? "", obj.raw, localDomain),
    emojis: filterUsedEmojis([obj.content, obj.contentWarning], opts.emojis ?? []).map(serializeEmoji),
    card: null,
    poll: opts.poll ?? null,
    filtered: [],
    quotes_count: 0,
    quote: null,
    favourited: opts.favourited ?? false,
    reblogged: opts.reblogged ?? false,
    muted: false,
    bookmarked: false,
    pinned: opts.pinned ?? false,
    ...buildTypeMeta(obj),
  };
}

/**
 * Rewrite links to remote profile pages in status content so they point to the
 * local resolver route `/users/remote?url=...` instead of the original server.
 * Remote actors are identified from the structured `tag` mentions in the raw AP
 * JSON (reliable) plus a `class`-based fallback for `mention` links.
 */
export function rewriteProfileLinks(
  content: string,
  raw: string,
  localDomain: string
): string {
  if (!content || !content.includes("<a")) return content;

  const localBase = `https://${localDomain}`;

  // Collect remote actor URLs from the structured mention tags.
  const remoteActorHrefs = new Set<string>();
  try {
    const parsed = JSON.parse(raw) as APObject;
    const tags = Array.isArray(parsed.tag) ? parsed.tag : [];
    for (const t of tags) {
      if (t.type === "Mention" && typeof t.href === "string" && t.href) {
        const href = t.href.startsWith("/") ? `${localBase}${t.href}` : t.href;
        if (!href.startsWith(localBase)) remoteActorHrefs.add(href);
      }
    }
  } catch {
    /* malformed raw */
  }

  return content.replace(/<a\b([^>]*?)\bhref="([^"]*)"([^>]*)>/g, (match, pre, href, post) => {
    const isLocal = href.startsWith(localBase) || href.startsWith("/");
    const isKnownRemote = !isLocal && remoteActorHrefs.has(href);
    const isMentionClass = /\bmention\b/.test(pre + post);
    // Hashtag links (Mastodon marks them `class="mention hashtag" rel="tag"`,
    // but GoToSocial/Akkoma use plain `class="hashtag"`) must never be routed
    // to the remote-profile resolver — they are tags, not actors.
    const isHashtag = /\bhashtag\b/.test(pre + post) || /\brel="tag"\b/.test(pre + post) || /\/tags\//.test(href);
    // Hashtag links (Mastodon marks them `class="mention hashtag" rel="tag"`,
    // GoToSocial/Akkoma use plain `class="hashtag"`) are tags, not actors — they
    // must resolve on the local instance, not the remote-profile resolver.
    if (isHashtag) {
      const tagName = href.split("/").filter(Boolean).pop() ?? "";
      try {
        const decoded = decodeURIComponent(tagName);
        if (decoded) {
          const cleanPost = post.replace(/\s*target="_blank"/g, "");
          return `<a${pre} href="/tags/${decoded.toLowerCase()}"${cleanPost}>`;
        }
      } catch { /* malformed percent-encoding */ }
      return match;
    }
    if (isLocal || (!isKnownRemote && !isMentionClass)) return match;

    const local = `/users/remote?url=${encodeURIComponent(href)}`;
    // Drop target="_blank" (the local resolver page should open in-place).
    const cleanPost = post.replace(/\s*target="_blank"/g, "");
    return `<a${pre} href="${local}"${cleanPost}>`;
  });
}

/**
 * Resolve the ActivityStreams object type + metadata for a stored object.
 * The DB `type` column holds the AP type for federated objects; locally-authored
 * posts are stored as "Note" even when the wire type is "Question" (polls), so we
 * fall back to the type embedded in the raw AP JSON.
 */
function resolveAPType(obj: LocalObject): string {
  const dbType = obj.type || "Note";
  if (dbType !== "Note") return dbType;
  try {
    const raw = JSON.parse(obj.raw) as APObject | undefined;
    const rawType = typeof raw?.type === "string" ? raw.type : null;
    if (rawType && rawType !== "Note") return rawType as string;
  } catch {
    /* malformed raw */
  }
  return "Note";
}

/** Extract type-specific metadata (title, time ranges, place, duration, links). */
export function extractAPMeta(obj: LocalObject): APObjectMeta | null {
  let raw: APObject | null = null;
  try {
    raw = JSON.parse(obj.raw) as APObject;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const name = typeof raw.name === "string" ? raw.name : null;
  const startTime = typeof raw.startTime === "string" ? raw.startTime : null;
  const endTime = typeof raw.endTime === "string" ? raw.endTime : null;

  let duration: number | null = null;
  if (Array.isArray(raw.duration)) {
    const d = raw.duration.find((x) => typeof x === "number");
    if (typeof d === "number") duration = d;
  } else if (typeof raw.duration === "number") {
    duration = raw.duration;
  } else if (typeof raw.duration === "string") {
    const d = raw.duration.trim();
    // ISO 8601 durations ("PT68S", "PT1M2S", "PT1H2M3S") or plain seconds.
    const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d);
    if (iso) {
      const [, days, hours, mins, secs] = iso;
      const total =
        (days ? parseInt(days, 10) * 86400 : 0) +
        (hours ? parseInt(hours, 10) * 3600 : 0) +
        (mins ? parseInt(mins, 10) * 60 : 0) +
        (secs ? parseFloat(secs) : 0);
      if (total > 0) duration = total;
    } else {
      const n = Number(d.replace(/^(\d+)s$/, "$1"));
      if (Number.isFinite(n) && n > 0) duration = n;
    }
  }

  let latitude: number | null = null;
  let longitude: number | null = null;
  if (Array.isArray(raw.latitude)) {
    const lat = raw.latitude[0];
    if (typeof lat === "number") latitude = lat;
  } else if (typeof raw.latitude === "number") {
    latitude = raw.latitude;
  }
  if (Array.isArray(raw.longitude)) {
    const lng = raw.longitude[0];
    if (typeof lng === "number") longitude = lng;
  } else if (typeof raw.longitude === "number") {
    longitude = raw.longitude;
  }

  // `location` may be a Place object (with its own name/latitude/longitude)
  const locationObj = typeof raw.location === "object" && raw.location !== null ? raw.location as Record<string, unknown> : null;
  const locationName = locationObj && typeof locationObj.name === "string" ? locationObj.name : typeof raw.location === "string" ? raw.location : null;
  if (locationObj) {
    if (Array.isArray(locationObj.latitude)) {
      const lat = (locationObj.latitude as unknown[])[0];
      if (typeof lat === "number") latitude = lat;
    } else if (typeof locationObj.latitude === "number") {
      latitude = locationObj.latitude as number;
    }
    if (Array.isArray(locationObj.longitude)) {
      const lng = (locationObj.longitude as unknown[])[0];
      if (typeof lng === "number") longitude = lng;
    } else if (typeof locationObj.longitude === "number") {
      longitude = locationObj.longitude as number;
    }
  }

  // The display URL may be a string, a list, or a Link object (href). For
  // top-level Audio/Video/Image objects the url list often mixes the watch
  // page (mediaType text/html) with the actual media file (mediaType
  // video/mp4, image/jpeg, audio/…). We keep the page as `url` (the "open
  // original" target) and the media file as `mediaUrl`.
  const rawUrl = raw.url;
  const urlEntries: { href: string; mediaType?: string }[] = [];
  const collectUrl = (u: unknown): void => {
    if (typeof u === "string") { urlEntries.push({ href: u }); return; }
    if (u && typeof u === "object") {
      const rec = u as Record<string, unknown>;
      if (typeof rec.href === "string") {
        urlEntries.push({ href: rec.href, mediaType: typeof rec.mediaType === "string" ? rec.mediaType : undefined });
      }
    }
  };
  if (typeof rawUrl === "string") collectUrl(rawUrl);
  else if (Array.isArray(rawUrl)) for (const u of rawUrl) collectUrl(u);
  else if (rawUrl && typeof rawUrl === "object") collectUrl(rawUrl);

  const isMediaMime = (mt?: string): boolean =>
    !!mt && (mt.startsWith("video/") || mt.startsWith("audio/") || mt.startsWith("image/"));

  // The canonical page link is the first html/any non-media entry, falling
  // back to the first entry overall (single-URL objects, e.g. a direct media
  // file string).
  const mediaEntry = urlEntries.find((e) => isMediaMime(e.mediaType));
  const pageEntry = urlEntries.find((e) => !isMediaMime(e.mediaType));
  let url: string | null = pageEntry?.href ?? urlEntries[0]?.href ?? null;
  let mediaUrl: string | null = mediaEntry?.href ?? null;
  // Objects that expose a single media URL (plain string or a Link with a
  // media mime) use that same URL as both the media source and the link
  // target — there is no distinct watch page.
  if (!mediaUrl && url && /\.(mp4|webm|ogg|ogv|mov|m4v|mp3|oga|wav|flac|m4a|jpg|jpeg|png|gif|webp|bmp|avif)(#|\?|$)/i.test(url)) {
    mediaUrl = url;
  }

  // Poster/preview thumbnail from the object's icon or image (PeerTube sends
  // icon, Mastodon uses icon/image, some servers send a Link object).
  let imageUrl: string | null = null;
  const icon = Array.isArray(raw.icon) ? raw.icon : raw.icon ? [raw.icon] : [];
  const image = Array.isArray(raw.image) ? raw.image : raw.image ? [raw.image] : [];
  for (const src of [...icon, ...image]) {
    if (!src || typeof src !== "object") continue;
    const rec = src as Record<string, unknown>;
    if (typeof rec.url === "string") { imageUrl = rec.url; break; }
    if (typeof rec.href === "string") { imageUrl = rec.href; break; }
  }

  // Fallback: the stored objects.url column is always resolved (falls back to
  // the object id via resolveObjectUrl), so a Page/Article without a raw `url`
  // still links to its canonical object URL instead of rendering a dead link.
  if (!url && typeof obj.url === "string" && obj.url) url = obj.url;

  // Relationship (as:subject / as:object / as:relationship)
  const subject = typeof raw.subject === "string" ? raw.subject : null;
  let relationshipObject: string | null = null;
  const rawRObject = raw.object;
  if (typeof rawRObject === "string") relationshipObject = rawRObject;
  else if (rawRObject && typeof rawRObject === "object") {
    const roId = (rawRObject as Record<string, unknown>).id;
    if (typeof roId === "string") relationshipObject = roId;
  }
  let relationship: string | null = null;
  const rawRel = raw.relationship;
  if (typeof rawRel === "string") relationship = rawRel;
  else if (rawRel && typeof rawRel === "object") {
    const relId = (rawRel as Record<string, unknown>).id;
    if (typeof relId === "string") relationship = relId;
  }

  // Tombstone (as:formerType / as:deleted)
  const formerType = typeof raw.formerType === "string" ? raw.formerType : null;
  const deleted = typeof raw.deleted === "string" ? raw.deleted : null;

  // Collection (as:totalItems)
  let totalItems: number | null = null;
  if (typeof raw.totalItems === "number" && Number.isFinite(raw.totalItems)) {
    totalItems = raw.totalItems;
  }

  // Profile (as:describes)
  const describes = typeof raw.describes === "string" ? raw.describes : null;

  const meta: APObjectMeta = {
    name: name ?? null,
    startTime: startTime ?? null,
    endTime: endTime ?? null,
    duration,
    location: locationName,
    latitude,
    longitude,
    url,
    mediaUrl,
    imageUrl,
    subject,
    relationshipObject,
    relationship,
    formerType,
    deleted,
    totalItems,
    describes,
  };
  const hasData = Object.values(meta).some((v) => v != null);
  return hasData ? meta : null;
}

/** Build the { ap_type, ap_meta } payload for a serialized status. */
function buildTypeMeta(obj: LocalObject): { ap_type?: string; ap_meta?: APObjectMeta | null } {
  const type = resolveAPType(obj);
  // Public MLS messages appear on the public timeline as encrypted-envelope
  // posts; surface their type so the UI can render the MLS/PublicMessage badge.
  if (type === "PublicMessage") return { ap_type: type, ap_meta: extractAPMeta(obj) };
  // A plain Note never renders a badge or type block, so emitting
  // `ap_type: "Note"` / `ap_meta: null` on every status is needless payload.
  // Only meaningful (non-Note) renderable types carry the extension fields.
  if (type === "Note" || !isRenderableObjectType(type)) return {};
  return { ap_type: type, ap_meta: extractAPMeta(obj) };
}

// ─────────────────────────────────────────
// Poll serializer
// ─────────────────────────────────────────

export function serializePoll(
  poll: LocalPoll,
  options: LocalPollOption[],
  voted: boolean,
  ownVotes: number[],
  emojis: LocalCustomEmoji[] = []
): MastodonPoll {
  const now = new Date();
  const expired = now > new Date(poll.expiresAt);
  return {
    id: poll.id,
    expires_at: toIso(poll.expiresAt) ?? poll.expiresAt,
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
    emojis: emojis.map(serializeEmoji),
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
    created_at: toIso(notif.createdAt) ?? new Date().toISOString(),
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
  contactAccount: MastodonAccount | null = null,
  vapidPublicKey?: string,
  languages: string[] = ["en", "es", "fr", "de", "it", "ja", "ko", "pt", "ru", "zh-Hans"],
  rules: { id: string; text: string }[] = []
): MastodonInstance {
  return {
    uri: domain,
    title,
    version: `4.7.0 (compatible; ${version})`,
    source_url: "https://github.com/manalejandro/cf-activitypub-next",
    description,
    usage: { users: { active_month: userCount } },
    thumbnail: { url: `https://${domain}/logo.svg` },
    languages,
    ...(vapidPublicKey ? { vapid_public_key: vapidPublicKey } : {}),
    configuration: {
      urls: { streaming: `wss://${domain}/api/v1/streaming` },
      accounts: { max_featured_tags: 10 },
      ...(vapidPublicKey ? { vapid: { secret_key: vapidPublicKey } } : {}),
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
      calls: { enabled: true },
    },
    registrations: { enabled: true, approval_required: false, message: null },
    contact: { email: `admin@${domain}`, account: contactAccount },
    rules,
  };
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

export function serializeAttachment(att: LocalAttachment): MastodonAttachment {
  const mimeToType = (mime: string | null): MastodonAttachment["type"] => {
    if (!mime) return "unknown";
    if (mime.startsWith("image/gif")) return "gifv";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "unknown";
  };
  // The DB stores the remote AP attachment type (lowercased) even when the
  // server omitted a mimeType (e.g. brid.gy / Instagram videos). Use it as a
  // fallback so media still renders with the right player.
  const type = mimeToType(att.mimeType) === "unknown"
    ? (["gifv", "image", "video", "audio"].includes((att.type ?? "").toLowerCase())
        ? (att.type.toLowerCase() as MastodonAttachment["type"])
        : "unknown")
    : mimeToType(att.mimeType);
  const meta: MastodonAttachmentMeta | undefined =
    att.width && att.height
      ? {
          original: { width: att.width, height: att.height, aspect: att.width / att.height },
          small: { width: att.width, height: att.height, aspect: att.width / att.height },
        }
      : undefined;

  return {
    id: att.id,
    type,
    url: att.url,
    preview_url: att.url,
    remote_url: att.remoteUrl ?? null,
    text_url: null,
    description: att.description ?? null,
    blurhash: att.blurhash ?? null,
    sensitive: att.sensitive,
    meta,
  };
}

function extractMentionsFromRaw(raw: string, localDomain: string): MastodonMention[] {
  try {
    const parsed = JSON.parse(raw);
    const tags = parsed.tag as APTag[] | undefined;
    if (!Array.isArray(tags)) return [];
    return tags
      .filter((t: APTag) => t.type === "Mention" && t.href && t.name)
      .map((t: APTag) => {
        const href = t.href!.startsWith("/") ? `https://${localDomain}${t.href}` : t.href!;
        const name = t.name!.startsWith("@") ? t.name!.slice(1) : t.name!;
        const username = name.includes("@") ? name.split("@")[0] : name;
        return { id: href, username, url: href, acct: name };
      });
  } catch {
    return [];
  }
}

/**
 * Hashtag extraction. Prefers the structured `tag` array stored in the AP raw
 * JSON (handles non-ASCII names like #café) and falls back to a regex over the
 * rendered HTML. URLs point at the local tag page, like Mastodon.
 */
function extractHashtags(content: string, raw?: string, localDomain?: string): { name: string; url: string }[] {
  const urlOf = (name: string) => (localDomain ? `https://${localDomain}/tags/${encodeURIComponent(name)}` : "");

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const tags = parsed.tag as APTag[] | undefined;
      if (Array.isArray(tags)) {
        const hits = tags
          .filter((t: APTag) => t.type === "Hashtag" && t.name)
          .map((t: APTag) => ({ name: t.name!.replace(/^#/, "").toLowerCase(), href: t.href }));
        if (hits.length > 0) {
          return [...new Map(hits.map((h) => [h.name, h])).values()].map((h) => ({
            name: h.name,
            url: h.href ?? urlOf(h.name),
          }));
        }
      }
    } catch { /* fall through to regex */ }
  }

  const matches = content.match(/#([^\s<,.:;!?]+)/g) ?? [];
  return [...new Set(matches.map((tag) => tag.slice(1).toLowerCase()))].map((name) => ({
    name,
    url: urlOf(name),
  }));
}

/**
 * Load all active custom emoji from the database.
 * Convenience helper for route handlers.
 */
export async function loadEmojis(db: D1Database): Promise<LocalCustomEmoji[]> {
  const rows = await db
    .prepare("SELECT * FROM custom_emojis WHERE disabled = 0 ORDER BY category, shortcode ASC")
    .all<Record<string, unknown>>();
  return rows.results.map((r) => ({
    id: r.id as string,
    shortcode: r.shortcode as string,
    url: r.url as string,
    staticUrl: r.static_url as string,
    category: (r.category as string | null) ?? null,
    visibleInPicker: Boolean(r.visible_in_picker),
    domain: (r.domain as string | null) ?? null,
    actorId: (r.actor_id as string | null) ?? null,
    disabled: Boolean(r.disabled),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }));
}
