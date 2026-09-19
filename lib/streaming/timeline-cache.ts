import type { Dispatch, SetStateAction } from "react";

export interface TimelineCacheEntry<T> {
  items: T[];
  hasMore: boolean;
  scrollY: number;
  fetchedAt: number;
  ready: boolean;
  /**
   * Status that was visible at the top when the feed was left. Restoring
   * anchors to it (instead of the feed's first item) so a history traversal
   * keeps the exact position even if new posts arrived meanwhile.
   */
  anchorId?: string | null;
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

/**
 * Replace a status in every cached feed where it appears (e.g. its
 * `bookmarked`/`favourited`/counters changed). Feeds where the status no
 * longer belongs (bookmarks after unbookmark, favourites after unfavourite)
 * are handled by the page that performed the change.
 */
export function updateStatusInCache<T extends { id: string }>(status: T): void {
  for (const entry of entries.values()) {
    const items = entry.items as T[];
    if (items.some((s) => s.id === status.id)) {
      entry.items = items.map((s) => (s.id === status.id ? mergeStatusUpdate(s, status) : s));
    }
  }
}

/**
 * Viewer-specific fields that a broadcast `status.update` cannot know (its
 * payload is shared by every viewer) and must therefore never clobber when a
 * cached status is refreshed.
 */
const VIEWER_FIELDS = ["favourited", "reblogged", "bookmarked", "muted", "pinned", "filtered"] as const;

/** Merge a broadcast status update over the copy the viewer already has. */
export function mergeStatusUpdate<T extends { id: string }>(existing: T, updated: T): T {
  const base = existing as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base, ...(updated as Record<string, unknown>) };
  for (const key of VIEWER_FIELDS) {
    if (key in base) merged[key] = base[key];
  }
  return merged as T;
}

/**
 * Reconcile a cached feed with a freshly fetched first page: a cached item
 * inside the fetched window (between the page's oldest and newest items) that
 * the server no longer returns was deleted (or hidden) and must not come back
 * from the cache. Items newer than the window are kept — they may have arrived
 * over streaming while the page was being fetched — and items older than the
 * window belong to later pages that were not re-fetched.
 */
export function pruneMissingFromWindow<T extends TimelineItem>(fetched: T[], cached: T[]): T[] {
  if (fetched.length === 0 || cached.length === 0) return cached;
  const newest = fetched[0]?.created_at;
  const oldest = fetched[fetched.length - 1]?.created_at;
  if (!newest || !oldest) return cached;
  const ids = new Set(fetched.map((item) => item.id));
  return cached.filter((item) => {
    if (ids.has(item.id)) return true;
    const created = item.created_at;
    // No timestamp (notifications without one…) can't be placed in the window.
    if (!created) return true;
    return created > newest || created < oldest;
  });
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
      updateStatusInCache(status);
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
      updateStatusInCache(updated);
      setItems((prev) => prev.map((s) => (s.id === updated.id ? mergeStatusUpdate(s, updated) : s)));
    } catch { /* ignore malformed payload */ }
    return true;
  }
  return false;
}
