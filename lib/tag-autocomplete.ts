/** Client-side tag shape returned by /api/v1/tags/search. */
export interface TagSuggestion {
  id?: string;
  name: string;
  url: string;
  history?: { day: string; uses: string; accounts: string }[];
  following?: boolean;
}

/**
 * Find the `#query` being typed right before `cursorPos` in `text`.
 * The `#` must be at the start of the text or preceded by whitespace, so URL
 * fragments (`page#section`) never trigger. The query must be at least two
 * characters (same threshold as the mention and emoji autocompletes).
 */
export function findTagQuery(
  text: string,
  cursorPos: number
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursorPos);
  const m = /(^|[^\S\r\n])(#([^\s#]+))$/.exec(before);
  if (!m) return null;
  const query = m[3];
  if (query.length < 2) return null;
  return { start: cursorPos - m[2].length, end: cursorPos, query };
}

export function replaceTagQuery(
  text: string,
  range: { start: number; end: number },
  insert: string
): string {
  return text.slice(0, range.start) + insert + text.slice(range.end);
}
