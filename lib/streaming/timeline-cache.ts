export interface TimelineCacheEntry<T> {
  items: T[];
  hasMore: boolean;
  seenIds: string[];
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

/** Remove a status from every cached timeline so a restored feed never shows it. */
export function purgeStatusFromCache(statusId: string): void {
  for (const entry of entries.values()) {
    entry.items = entry.items.filter((s) => (s as { id: string }).id !== statusId);
    entry.seenIds = entry.seenIds.filter((id) => id !== statusId);
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