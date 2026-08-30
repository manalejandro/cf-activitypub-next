// Single source of truth for instance capability limits. Reported by
// /api/v1/instance (serializeInstance) AND enforced by the API + client
// compositors, so a limit is never hardcoded in two places that can drift.
//
// Every limit can be overridden at runtime with a Cloudflare [vars] entry whose
// name matches the constant (e.g. `MAX_STATUS_CHARS = "1000"` in wrangler.toml).
// Server code resolves the effective values with resolveLimits(env); client
// components read the same values via /api/v1/instance (see lib/limits-client).

export const MAX_STATUS_CHARS = 500;
export const MAX_CW_CHARS = 200;
export const MAX_ALT_TEXT_CHARS = 420;
export const MAX_MEDIA_ATTACHMENTS = 4;
export const MAX_POLL_OPTIONS = 4;
export const MAX_POLL_OPTION_CHARS = 50;
export const POLL_MIN_EXPIRATION = 300; // 5 minutes
export const POLL_MAX_EXPIRATION = 2_629_746; // ~1 month
export const MAX_FEATURED_TAGS = 10;
export const CHARACTERS_RESERVED_PER_URL = 23;

export const MAX_PROFILE_FIELDS = 4;
export const MAX_PROFILE_FIELD_CHARS = 255;
export const MAX_DISPLAY_NAME_CHARS = 30;
export const MAX_NOTE_CHARS = MAX_STATUS_CHARS;
export const MAX_EMOJI_SHORTCODE_CHARS = 32;
export const MAX_FEATURED_TAG_NAME_CHARS = 64;
export const MAX_COLLECTION_NAME_CHARS = 40;
export const MAX_COLLECTION_DESCRIPTION_CHARS = 100;
export const MAX_ANNOUNCEMENT_CHARS = 10000;
export const MAX_LANG_CODE_CHARS = 2;
export const PAGE_SIZE = 40;
export const DEFAULT_TIMELINE_PAGE = 20;
export const MAX_PAGE_SIZE = 40;
export const MAX_COLLECTION_PAGE = 80;
export const TRENDING_TAGS_LIMIT = 10;
export const TRENDING_TAGS_MAX = 20;
export const ADMIN_LOG_PAGE_SIZE = 100;

export const MAX_IMAGE_SIZE = 16 * 1024 * 1024; // 16 MB
export const MAX_VIDEO_SIZE = 103_809_024; // ~99 MB
export const IMAGE_MATRIX_LIMIT = 33_177_600;
export const VIDEO_FRAME_RATE_LIMIT = 120;
export const VIDEO_MATRIX_LIMIT = 2_304_000;
export const SUPPORTED_MEDIA_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
];

export const INSTANCE_LANGUAGES = ["en", "es", "fr", "de", "it", "ja", "ko", "pt", "ru", "zh-Hans"];
export const MASTODON_COMPAT_VERSION = "4.7.0";

/** Effective instance limits — the shape exposed to clients via /api/v1/instance. */
export interface InstanceLimits {
  maxStatusChars: number;
  maxCwChars: number;
  maxAltTextChars: number;
  maxMediaAttachments: number;
  maxPollOptions: number;
  maxPollOptionChars: number;
  pollMinExpiration: number;
  pollMaxExpiration: number;
  maxFeaturedTags: number;
  charactersReservedPerUrl: number;
  maxProfileFields: number;
  maxProfileFieldChars: number;
  maxDisplayNameChars: number;
  maxNoteChars: number;
  maxEmojiShortcodeChars: number;
  maxFeaturedTagNameChars: number;
  maxCollectionNameChars: number;
  maxCollectionDescriptionChars: number;
  maxAnnouncementChars: number;
  maxLangCodeChars: number;
  pageSize: number;
  defaultTimelinePage: number;
  maxPageSize: number;
  maxCollectionPage: number;
  trendingTagsLimit: number;
  trendingTagsMax: number;
  adminLogPageSize: number;
  maxImageSize: number;
  maxVideoSize: number;
  imageMatrixLimit: number;
  videoFrameRateLimit: number;
  videoMatrixLimit: number;
}

export const DEFAULT_LIMITS: InstanceLimits = {
  maxStatusChars: MAX_STATUS_CHARS,
  maxCwChars: MAX_CW_CHARS,
  maxAltTextChars: MAX_ALT_TEXT_CHARS,
  maxMediaAttachments: MAX_MEDIA_ATTACHMENTS,
  maxPollOptions: MAX_POLL_OPTIONS,
  maxPollOptionChars: MAX_POLL_OPTION_CHARS,
  pollMinExpiration: POLL_MIN_EXPIRATION,
  pollMaxExpiration: POLL_MAX_EXPIRATION,
  maxFeaturedTags: MAX_FEATURED_TAGS,
  charactersReservedPerUrl: CHARACTERS_RESERVED_PER_URL,
  maxProfileFields: MAX_PROFILE_FIELDS,
  maxProfileFieldChars: MAX_PROFILE_FIELD_CHARS,
  maxDisplayNameChars: MAX_DISPLAY_NAME_CHARS,
  maxNoteChars: MAX_NOTE_CHARS,
  maxEmojiShortcodeChars: MAX_EMOJI_SHORTCODE_CHARS,
  maxFeaturedTagNameChars: MAX_FEATURED_TAG_NAME_CHARS,
  maxCollectionNameChars: MAX_COLLECTION_NAME_CHARS,
  maxCollectionDescriptionChars: MAX_COLLECTION_DESCRIPTION_CHARS,
  maxAnnouncementChars: MAX_ANNOUNCEMENT_CHARS,
  maxLangCodeChars: MAX_LANG_CODE_CHARS,
  pageSize: PAGE_SIZE,
  defaultTimelinePage: DEFAULT_TIMELINE_PAGE,
  maxPageSize: MAX_PAGE_SIZE,
  maxCollectionPage: MAX_COLLECTION_PAGE,
  trendingTagsLimit: TRENDING_TAGS_LIMIT,
  trendingTagsMax: TRENDING_TAGS_MAX,
  adminLogPageSize: ADMIN_LOG_PAGE_SIZE,
  maxImageSize: MAX_IMAGE_SIZE,
  maxVideoSize: MAX_VIDEO_SIZE,
  imageMatrixLimit: IMAGE_MATRIX_LIMIT,
  videoFrameRateLimit: VIDEO_FRAME_RATE_LIMIT,
  videoMatrixLimit: VIDEO_MATRIX_LIMIT,
};

function num(env: Record<string, unknown>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Effective limits for a given environment. Reads each limit's homonymous
 * Cloudflare var (e.g. `MAX_STATUS_CHARS`) and falls back to the default.
 */
export function resolveLimits(env: Record<string, unknown>): InstanceLimits {
  const maxStatusChars = num(env, "MAX_STATUS_CHARS", DEFAULT_LIMITS.maxStatusChars);
  return {
    ...DEFAULT_LIMITS,
    maxStatusChars,
    maxNoteChars: num(env, "MAX_NOTE_CHARS", maxStatusChars),
    maxCwChars: num(env, "MAX_CW_CHARS", DEFAULT_LIMITS.maxCwChars),
    maxAltTextChars: num(env, "MAX_ALT_TEXT_CHARS", DEFAULT_LIMITS.maxAltTextChars),
    maxMediaAttachments: num(env, "MAX_MEDIA_ATTACHMENTS", DEFAULT_LIMITS.maxMediaAttachments),
    maxPollOptions: num(env, "MAX_POLL_OPTIONS", DEFAULT_LIMITS.maxPollOptions),
    maxPollOptionChars: num(env, "MAX_POLL_OPTION_CHARS", DEFAULT_LIMITS.maxPollOptionChars),
    pollMinExpiration: num(env, "POLL_MIN_EXPIRATION", DEFAULT_LIMITS.pollMinExpiration),
    pollMaxExpiration: num(env, "POLL_MAX_EXPIRATION", DEFAULT_LIMITS.pollMaxExpiration),
    maxFeaturedTags: num(env, "MAX_FEATURED_TAGS", DEFAULT_LIMITS.maxFeaturedTags),
    charactersReservedPerUrl: num(env, "CHARACTERS_RESERVED_PER_URL", DEFAULT_LIMITS.charactersReservedPerUrl),
    maxProfileFields: num(env, "MAX_PROFILE_FIELDS", DEFAULT_LIMITS.maxProfileFields),
    maxProfileFieldChars: num(env, "MAX_PROFILE_FIELD_CHARS", DEFAULT_LIMITS.maxProfileFieldChars),
    maxDisplayNameChars: num(env, "MAX_DISPLAY_NAME_CHARS", DEFAULT_LIMITS.maxDisplayNameChars),
    maxEmojiShortcodeChars: num(env, "MAX_EMOJI_SHORTCODE_CHARS", DEFAULT_LIMITS.maxEmojiShortcodeChars),
    maxFeaturedTagNameChars: num(env, "MAX_FEATURED_TAG_NAME_CHARS", DEFAULT_LIMITS.maxFeaturedTagNameChars),
    maxCollectionNameChars: num(env, "MAX_COLLECTION_NAME_CHARS", DEFAULT_LIMITS.maxCollectionNameChars),
    maxCollectionDescriptionChars: num(env, "MAX_COLLECTION_DESCRIPTION_CHARS", DEFAULT_LIMITS.maxCollectionDescriptionChars),
    maxAnnouncementChars: num(env, "MAX_ANNOUNCEMENT_CHARS", DEFAULT_LIMITS.maxAnnouncementChars),
    maxLangCodeChars: num(env, "MAX_LANG_CODE_CHARS", DEFAULT_LIMITS.maxLangCodeChars),
    pageSize: num(env, "PAGE_SIZE", DEFAULT_LIMITS.pageSize),
    defaultTimelinePage: num(env, "DEFAULT_TIMELINE_PAGE", DEFAULT_LIMITS.defaultTimelinePage),
    maxPageSize: num(env, "MAX_PAGE_SIZE", DEFAULT_LIMITS.maxPageSize),
    maxCollectionPage: num(env, "MAX_COLLECTION_PAGE", DEFAULT_LIMITS.maxCollectionPage),
    trendingTagsLimit: num(env, "TRENDING_TAGS_LIMIT", DEFAULT_LIMITS.trendingTagsLimit),
    trendingTagsMax: num(env, "TRENDING_TAGS_MAX", DEFAULT_LIMITS.trendingTagsMax),
    adminLogPageSize: num(env, "ADMIN_LOG_PAGE_SIZE", DEFAULT_LIMITS.adminLogPageSize),
    maxImageSize: num(env, "MAX_IMAGE_SIZE", DEFAULT_LIMITS.maxImageSize),
    maxVideoSize: num(env, "MAX_VIDEO_SIZE", DEFAULT_LIMITS.maxVideoSize),
    imageMatrixLimit: num(env, "IMAGE_MATRIX_LIMIT", DEFAULT_LIMITS.imageMatrixLimit),
    videoFrameRateLimit: num(env, "VIDEO_FRAME_RATE_LIMIT", DEFAULT_LIMITS.videoFrameRateLimit),
    videoMatrixLimit: num(env, "VIDEO_MATRIX_LIMIT", DEFAULT_LIMITS.videoMatrixLimit),
  };
}