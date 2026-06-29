export interface EmojiData {
  shortcode: string;
  url: string;
  static_url: string;
}

/**
 * Replace :shortcode: patterns in HTML content with custom emoji <img> tags.
 * This is used on the frontend to render emoji from the `emojis` array
 * returned by the Mastodon API.
 */
export function renderEmojiInHtml(
  html: string,
  emojis: EmojiData[]
): string {
  if (!emojis || emojis.length === 0) return html;

  // Build a map for O(1) lookup
  const emojiMap = new Map<string, EmojiData>();
  for (const e of emojis) {
    emojiMap.set(e.shortcode, e);
  }

  // Match :shortcode: patterns only in text nodes (not inside HTML tags).
  // The first alternative captures full HTML tags (including their attributes),
  // so :shortcode: patterns inside attribute values are left untouched.
  return html.replace(/(<[^>]*>)|:([a-zA-Z0-9_]+):/g, (match, tag, shortcode) => {
    if (tag) return tag;
    const emoji = emojiMap.get(shortcode);
    if (!emoji) return match;
    return `<img src="${emoji.url}" alt=":${shortcode}:" class="emojione" title=":${shortcode}:" width="16" height="16" />`;
  });
}

/**
 * Build a map of shortcode → EmojiData for quick lookup from the Mastodon API `emojis` response.
 */
export function buildEmojiMap(emojis: EmojiData[]): Map<string, EmojiData> {
  const map = new Map<string, EmojiData>();
  for (const e of emojis) {
    map.set(e.shortcode, e);
  }
  return map;
}
