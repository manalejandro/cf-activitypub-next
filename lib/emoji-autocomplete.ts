import { EMOJI_NAMES } from "@/lib/emoji-names";

export interface CustomEmoji {
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker?: boolean;
}

export interface EmojiSuggestion {
  type: "unicode" | "custom";
  char?: string;
  shortcode: string;
  url?: string;
  name: string;
  insert: string;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, " ");
}

interface Ranked {
  entry: EmojiSuggestion;
  score: number;
}

function rankSuggestion(name: string, query: string): number | null {
  const norm = normalizeKey(name);
  const flat = norm.replace(/ /g, "");
  const q = normalizeKey(query);
  const qf = q.replace(/ /g, "");
  if (!q) return null;
  if (norm.startsWith(q) || flat.startsWith(qf)) return 0;
  if (norm.includes(q) || flat.includes(qf)) return 1;
  return null;
}

/**
 * Find the `:query` being typed right before `cursorPos` in `text`.
 * Returns null when there is no `:` prefix, it is shorter than 2 chars, or
 * the `:` is not preceded by a word boundary (avoids false triggers like
 * `http://` or `file:ts`).
 */
export function findEmojiQuery(
  text: string,
  cursorPos: number
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursorPos);
  const m = /(^|[^a-zA-Z0-9])(:([a-zA-Z0-9_]*))$/.exec(before);
  if (!m) return null;
  const query = m[3];
  if (query.length < 2) return null;
  return { start: cursorPos - m[2].length, end: cursorPos, query };
}

export function replaceEmojiQuery(
  text: string,
  range: { start: number; end: number },
  insert: string
): string {
  return text.slice(0, range.start) + insert + text.slice(range.end);
}

/**
 * Return emoji suggestions matching `query` by name/shortcode. Unicode emojis
 * come from EMOJI_NAMES (matched by CLDR name), custom emojis by shortcode.
 * Prefix matches rank above contains matches; custom emojis win ties.
 */
export function getEmojiSuggestions(
  query: string,
  customEmojis: CustomEmoji[],
  limit = 8
): EmojiSuggestion[] {
  const ranked: Ranked[] = [];

  for (const [char, name] of EMOJI_NAMES) {
    if (!name) continue;
    const score = rankSuggestion(name, query);
    if (score === null) continue;
    ranked.push({
      entry: { type: "unicode", char, shortcode: name, name, insert: char },
      score,
    });
  }

  for (const emoji of customEmojis) {
    if (!emoji.shortcode) continue;
    const score = rankSuggestion(emoji.shortcode, query);
    if (score === null) continue;
    ranked.push({
      entry: {
        type: "custom",
        shortcode: emoji.shortcode,
        url: emoji.url,
        name: emoji.shortcode,
        insert: `:${emoji.shortcode}:`,
      },
      score,
    });
  }

  ranked.sort((a, b) =>
    a.score !== b.score
      ? a.score - b.score
      : a.entry.type === b.entry.type
        ? a.entry.name.localeCompare(b.entry.name)
        : a.entry.type === "custom" ? -1 : 1
  );

  return ranked.slice(0, limit).map((r) => r.entry);
}