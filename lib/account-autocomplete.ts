/** Client-side account shape returned by /api/v1/accounts/search. */
export interface AccountSuggestion {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
  emojis?: { shortcode: string; url: string; static_url: string }[];
}

/**
 * Find the `@query` being typed right before `cursorPos` in `text`.
 * The `@` must be at the start of the text or preceded by whitespace, so
 * emails (`foo@bar`) and URLs never trigger. The query must be at least two
 * characters long (matches Mastodon's mention autocomplete threshold).
 */
export function findMentionQuery(
  text: string,
  cursorPos: number
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursorPos);
  const m = /(^|[^\S\r\n])(@([^\s]+))$/.exec(before);
  if (!m) return null;
  const query = m[3];
  if (query.length < 2) return null;
  return { start: cursorPos - m[2].length, end: cursorPos, query };
}

export function replaceMentionQuery(
  text: string,
  range: { start: number; end: number },
  insert: string
): string {
  return text.slice(0, range.start) + insert + text.slice(range.end);
}