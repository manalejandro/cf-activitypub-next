import type { Dispatch, SetStateAction } from "react";

export interface TimelineCacheEntry<T> {
  items: T[];
  hasMore: boolean;
  scrollY: number;
  fetchedAt: number;
  ready: boolean;
}

const TIMELINE_CACHE_TTL_MS = 5 * 60 * 1000;

const entries = new Map<string, TimelineCacheEntry<unknown>>();

export function getTimelineCache<T>(key: string): TimelineCacheEntry<T> | undefined {
  return entries.get(key) as TimelineCacheEntry<T> | undefined;
}

export function setTimelineCache<T>(key: string, entry: TimelineCacheEntry<T>): void {
  entries.set(key, entry as TimelineCacheEntry<unknown>);
}

export function clearTimelineCache(key: string): void {
  entries.delete(key);
}

/** Drop every cached feed — used when user filters change so cached statuses
 *  (which embed the old `filtered` results) are refetched from the server. */
export function clearAllTimelineCaches(): void {
  entries.clear();
}

/** Remove a status from every cached timeline so a restored feed never shows it. */
export function purgeStatusFromCache(statusId: string): void {
  for (const entry of entries.values()) {
    entry.items = (entry.items as { id: string }[]).filter((s) => s.id !== statusId);
  }
}

export function isTimelineCacheFresh<T>(entry: TimelineCacheEntry<T>): boolean {
  return entry.ready && Date.now() - entry.fetchedAt < TIMELINE_CACHE_TTL_MS;
}

let lastTimelineView: string | null = null;

export function getLastTimelineView(): string | null {
  return lastTimelineView;
}

export function setLastTimelineView(view: string): void {
  lastTimelineView = view;
}

/** Anything the timelines can order: Mastodon statuses / notifications. */
export interface TimelineItem {
  id: string;
  created_at?: string;
}

/**
 * Deduplicate by id and order newest-first by `created_at` — the same field the
 * server timelines order by (`published DESC`). Using one canonical merge keeps
 * streamed, paged and cached items in the exact order a reload would show, so a
 * late federated status can't jump to the top just because it arrived last.
 * Items without a date keep their relative (insertion) order: Array.sort is
 * stable.
 */
export function mergeTimelineItems<T extends TimelineItem>(...lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  out.sort((a, b) => {
    const ad = a.created_at ?? "";
    const bd = b.created_at ?? "";
    if (ad === bd) return 0;
    return ad < bd ? 1 : -1;
  });
  return out;
}

/**
 * Apply a Mastodon streaming event to a status feed. Shared by every timeline
 * page so update/delete/status.update behave identically. Returns false for
 * events it doesn't handle (e.g. `filters_changed`) so callers can react.
 */
export function handleStatusStreamEvent<T extends TimelineItem>(
  event: string,
  payload: string,
  setItems: Dispatch<SetStateAction<T[]>>,
  seenIds: Set<string>
): boolean {
  if (event === "update") {
    try {
      const status = JSON.parse(payload) as T;
      if (seenIds.has(status.id)) return true;
      seenIds.add(status.id);
      setItems((prev) => mergeTimelineItems([status], prev));
    } catch { /* ignore malformed payload */ }
    return true;
  }
  if (event === "delete") {
    const deletedId = payload.replace(/^"|"$/g, "");
    seenIds.delete(deletedId);
    purgeStatusFromCache(deletedId);
    setItems((prev) => prev.filter((s) => s.id !== deletedId));
    return true;
  }
  if (event === "status.update") {
    try {
      const updated = JSON.parse(payload) as T;
      setItems((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
    } catch { /* ignore malformed payload */ }
    return true;
  }
  return false;
}
