/**
 * Server-side user filters (Mastodon 4.0+ v2 API).
 *
 * Matching replicates Mastodon's `CustomFilterKeyword#to_regex`:
 *   - non-whole-word keywords are case-insensitive substrings;
 *   - whole-word keywords get a word boundary on each side *only* when the
 *     keyword itself starts/ends with a word constituent character. Word
 *     constituents follow Ruby's `[[:word:]]` (letters, marks, numbers and
 *     connector punctuation) so CJK and accented text behave like Mastodon.
 *
 * Statuses that match are annotated with the `filtered` attribute (FilterResult
 * list) so clients can apply the intended action per view context.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { encodeStatusId } from "@/lib/mastodon/statusId";
import {
  getFiltersForAccount,
  getFilterKeywords,
  getFilterStatuses,
  type LocalFilterRow,
} from "@/lib/db";

export type FilterContext = "home" | "notifications" | "public" | "thread" | "account";
export type FilterAction = "warn" | "hide" | "blur";

export const FILTER_CONTEXTS: FilterContext[] = ["home", "notifications", "public", "thread", "account"];
export const FILTER_ACTIONS: FilterAction[] = ["warn", "hide", "blur"];

export interface FilterKeyword {
  id: string;
  keyword: string;
  whole_word: boolean;
}

export interface FilterStatus {
  id: string;
  status_id: string;
}

export interface Filter {
  id: string;
  title: string;
  context: FilterContext[];
  expires_at: string | null;
  filter_action: FilterAction;
  keywords: FilterKeyword[];
  statuses: FilterStatus[];
}

export interface FilterResult {
  filter: { id: string; title: string; filter_action: FilterAction; context: FilterContext[]; expires_at: string | null };
  keyword_matches: string[];
  status_matches: string[];
}

// ── Keyword matching ──────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Ruby's [[:word:]] = Letter | Mark | Decimal_Number | Connector_Punctuation.
const WORD_CLASS = "\\p{L}\\p{M}\\p{N}\\p{Pc}";

function keywordRegex(keyword: string, wholeWord: boolean): RegExp {
  const escaped = escapeRegExp(keyword);
  if (!wholeWord) return new RegExp(escaped, "iu");
  const startsWithWord = new RegExp(`^[${WORD_CLASS}]`, "u").test(keyword);
  const endsWithWord = new RegExp(`[${WORD_CLASS}]$`, "u").test(keyword);
  const left = startsWithWord ? `(?<![${WORD_CLASS}])` : "";
  const right = endsWithWord ? `(?![${WORD_CLASS}])` : "";
  return new RegExp(left + escaped + right, "iu");
}

/** Plain-text the server matches keywords against (spoiler text + content). */
export function searchableText(obj: { content?: string | null; contentWarning?: string | null }): string {
  const html = obj.content ?? "";
  const stripped = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
  return `${obj.contentWarning ?? ""}\n${stripped}`;
}

// ── Loading / matching ───────────────────────────────────────────────────────

export interface ActiveFilter {
  id: string;
  title: string;
  action: FilterAction;
  context: FilterContext[];
  expiresAt: string | null;
  keywordRegexes: { keyword: string; regex: RegExp }[];
  statusIds: string[];
}

export async function loadActiveFilters(db: D1Database, accountId: string): Promise<ActiveFilter[]> {
  const filters = await getFiltersForAccount(db, accountId);
  if (filters.length === 0) return [];

  const filterIds = filters.map((f) => f.id);
  const [keywords, statuses] = await Promise.all([
    getFilterKeywords(db, filterIds),
    getFilterStatuses(db, filterIds),
  ]);

  return filters.map((f: LocalFilterRow) => {
    let context: FilterContext[];
    try {
      const raw = JSON.parse(f.context) as string[];
      context = raw.filter((c): c is FilterContext => FILTER_CONTEXTS.includes(c as FilterContext));
    } catch {
      context = [];
    }
    return {
      id: f.id,
      title: f.title,
      action: f.action,
      context,
      expiresAt: f.expiresAt,
      keywordRegexes: keywords
        .filter((k) => k.customFilterId === f.id)
        .map((k) => ({ keyword: k.keyword, regex: keywordRegex(k.keyword, k.wholeWord) })),
      statusIds: statuses.filter((s) => s.customFilterId === f.id).map((s) => s.statusId),
    };
  });
}

/**
 * Compute the FilterResult list for a single stored object. Returns [] when the
 * object matches no active filter. Context is NOT applied here — each result
 * carries the filter's full context list and the client decides per view.
 */
export function filterResultsForObject(
  obj: { id: string; local: boolean; content?: string | null; contentWarning?: string | null },
  activeFilters: ActiveFilter[]
): FilterResult[] {
  if (activeFilters.length === 0) return [];
  const statusApiId = encodeStatusId(obj.id, obj.local);
  const text = searchableText(obj);

  const results: FilterResult[] = [];
  for (const filter of activeFilters) {
    const keywordMatches: string[] = [];
    for (const { regex } of filter.keywordRegexes) {
      if (keywordMatches.length >= 3) break;
      const m = text.match(regex);
      if (m) keywordMatches.push(m[0]);
    }
    const statusMatches = filter.statusIds.filter((id) => id === statusApiId);
    if (keywordMatches.length === 0 && statusMatches.length === 0) continue;
    results.push({
      filter: {
        id: filter.id,
        title: filter.title,
        filter_action: filter.action,
        context: filter.context,
        expires_at: filter.expiresAt,
      },
      keyword_matches: keywordMatches,
      status_matches: statusMatches,
    });
  }
  return results;
}

/** Batch: build the `filtered` map for a set of objects (by object IRI). */
export async function getFilterResultsForStatuses(
  db: D1Database,
  accountId: string,
  objects: { id: string; local: boolean; content?: string | null; contentWarning?: string | null }[]
): Promise<Map<string, FilterResult[]>> {
  const map = new Map<string, FilterResult[]>();
  if (objects.length === 0) return map;
  const activeFilters = await loadActiveFilters(db, accountId);
  if (activeFilters.length === 0) return map;
  for (const obj of objects) {
    const results = filterResultsForObject(obj, activeFilters);
    if (results.length > 0) map.set(obj.id, results);
  }
  return map;
}

// ── API serializers ──────────────────────────────────────────────────────────

export function serializeFilterKeyword(k: { id: string; keyword: string; whole_word: boolean }): FilterKeyword {
  return { id: k.id, keyword: k.keyword, whole_word: k.whole_word };
}

export function serializeFilterStatus(s: { id: string; status_id: string }): FilterStatus {
  return { id: s.id, status_id: s.status_id };
}

export function serializeFilter(f: {
  id: string;
  title: string;
  context: FilterContext[];
  expires_at: string | null;
  filter_action: FilterAction;
  keywords: FilterKeyword[];
  statuses: FilterStatus[];
}): Filter {
  return {
    id: f.id,
    title: f.title,
    context: f.context,
    expires_at: f.expires_at,
    filter_action: f.filter_action,
    keywords: f.keywords,
    statuses: f.statuses,
  };
}

export function parseFilterContexts(raw: string): FilterContext[] {
  try {
    const arr = JSON.parse(raw) as string[];
    return arr.filter((c): c is FilterContext => FILTER_CONTEXTS.includes(c as FilterContext));
  } catch {
    return [];
  }
}

/** Load a filter row + its keywords/statuses and serialize as the v2 Filter. */
export async function loadFilterWithAssociations(
  db: D1Database,
  row: LocalFilterRow
): Promise<Filter> {
  const [keywords, statuses] = await Promise.all([
    getFilterKeywords(db, [row.id]),
    getFilterStatuses(db, [row.id]),
  ]);
  return serializeFilter({
    id: row.id,
    title: row.title,
    context: parseFilterContexts(row.context),
    expires_at: row.expiresAt,
    filter_action: row.action,
    keywords: keywords.map((k) => serializeFilterKeyword({ id: k.id, keyword: k.keyword, whole_word: k.wholeWord })),
    statuses: statuses.map((s) => serializeFilterStatus({ id: s.id, status_id: s.statusId })),
  });
}

/** Parse `keywords_attributes` from form data OR JSON (array of objects). */
export function parseKeywordsAttributes(
  raw: Record<string, unknown>
): { keyword: string; whole_word: boolean }[] {
  const out: { keyword: string; whole_word: boolean }[] = [];

  const arr = raw.keywords_attributes;
  if (Array.isArray(arr)) {
    for (const item of arr) {
      const o = (item ?? {}) as { keyword?: unknown; whole_word?: unknown };
      const text = String(o.keyword ?? "").trim();
      if (!text) continue;
      out.push({
        keyword: text.slice(0, 512),
        whole_word: o.whole_word === true || o.whole_word === "true",
      });
    }
    return out;
  }

  for (let i = 0; i < 50; i++) {
    const keyword = raw[`keywords_attributes[${i}][keyword]`];
    const wholeWord = raw[`keywords_attributes[${i}][whole_word]`];
    if (keyword === undefined) continue;
    const text = String(keyword).trim();
    if (!text) continue;
    out.push({
      keyword: text.slice(0, 512),
      whole_word: wholeWord === "true" || wholeWord === true,
    });
  }
  return out;
}