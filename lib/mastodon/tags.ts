/**
 * Mastodon `Tag` serialization helpers (trending tags + hashtag autocomplete).
 */

/** Stable numeric-looking id for a hashtag (same djb2 hash Mastodon clients see). */
export function tagId(name: string): string {
  let h = 5381;
  for (const c of name.toLowerCase()) {
    h = (((h << 5) + h) ^ c.charCodeAt(0)) & 0x7fffffff;
  }
  return String(h >>> 0);
}

export function serializeTag(
  name: string,
  domain: string,
  uses = 0,
  accounts = 0
): {
  id: string;
  name: string;
  url: string;
  history: { day: string; uses: string; accounts: string }[];
  following: boolean;
} {
  return {
    id: tagId(name),
    name,
    url: `https://${domain}/tags/${encodeURIComponent(name)}`,
    history: [
      {
        day: String(Math.floor(Date.now() / 1000 / 86400) * 86400),
        uses: String(uses),
        accounts: String(accounts),
      },
    ],
    following: false,
  };
}
