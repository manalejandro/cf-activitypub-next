// Single source of truth for instance capability limits. Reported by
// /api/v1/instance (serializeInstance) AND enforced by the API + client
// compositors, so a limit is never hardcoded in two places that can drift.

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

export const MAX_IMAGE_SIZE = 16 * 1024 * 1024; // 16 MB
export const MAX_VIDEO_SIZE = 103_809_024; // ~99 MB
export const SUPPORTED_MEDIA_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "audio/mpeg",
];

export const INSTANCE_LANGUAGES = ["en", "es", "fr", "de", "it", "ja", "ko", "pt", "ru", "zh-Hans"];
export const MASTODON_COMPAT_VERSION = "4.7.0";