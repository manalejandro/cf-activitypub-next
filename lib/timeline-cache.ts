import type { Status, Me } from "@/components/StatusCard";

interface TimelineCacheEntry {
  statuses: Status[];
  hasMore: boolean;
  me: Me | null;
  seenIds: string[];
  loadedAt: number;
}

const cache = new Map<string, TimelineCacheEntry>();

const CACHE_TTL = 5 * 60 * 1000;

export function getCachedTimeline(key: string): TimelineCacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.loadedAt > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry;
}

export function setCachedTimeline(
  key: string,
  statuses: Status[],
  hasMore: boolean,
  me: Me | null,
  seenIds: string[]
): void {
  cache.set(key, {
    statuses,
    hasMore,
    me,
    seenIds,
    loadedAt: Date.now(),
  });
}

export function updateCachedTimeline(key: string, updater: (entry: TimelineCacheEntry) => TimelineCacheEntry): void {
  const entry = cache.get(key);
  if (entry) {
    cache.set(key, updater(entry));
  }
}

export function clearCachedTimeline(key: string): void {
  cache.delete(key);
}
