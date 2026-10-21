"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useLimits } from "@/lib/limits-client";
import { NEW_STATUSES_TOP_OFFSET } from "./use-new-statuses";
import {
  getTimelineCache,
  isTimelineCacheFresh,
  mergeTimelineItems,
  pruneMissingFromWindow,
  pruneMissingInWindow,
  setTimelineCache,
} from "./timeline-cache";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * How many extra pages a catch-up may fetch to close the gap between the
 * statuses that arrived while the reader was away and the cached feed (5 × a
 * page ≈ 100 statuses, which covers a normal absence). A longer one stops
 * there: the remaining gap is walked by the scroll sentinel from the cursor.
 */
const MAX_GAP_PAGES = 5;

export interface FetchPageResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface UseTimelineCacheOptions<T = unknown> {
  /**
   * When true, entering this feed (a fresh mount, not a tab switch) always
   * starts at the top: the remembered scroll offset is discarded and any
   * browser/Next.js scroll restoration (e.g. back/forward) is overridden.
   */
  resetScrollOnEntry?: boolean;
  /**
   * When true, a fresh cached feed is still refetched in the background on
   * mount so posts that arrived while the page was closed are caught up. This
   * fixes feeds (like home) that have no tab-switch to trigger a refresh.
   */
  refetchOnMount?: boolean;
  /**
   * Called with the statuses a background refetch brought in while the reader
   * was scrolled away from the top. They stay out of the feed **and** out of the
   * cache — the caller queues them behind the "new statuses" pill — so coming
   * back to a timeline (from a status detail) never shifts it under the reader.
   */
  onDeferredItems?: (items: T[]) => void;
  /**
   * Utility feeds (bookmarks/favourites) whose membership changes elsewhere:
   * a background refetch replaces the first page instead of merging it, so
   * items removed on another screen (unbookmarked/unfavourited) don't linger
   * in the cached feed until a full reload.
   */
  replaceOnRefetch?: boolean;
}

// Set to true whenever the user traverses history (browser back/forward). The
// scroll position is only restored after such traversals — entering a feed
// through the sidebar or a tab switch should always start at the top.
let restoredOnHistoryTraversal = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    restoredOnHistoryTraversal = true;
  });
}

/** The first status visible in the viewport, used as the restore anchor. */
function topVisibleStatusId(): string | null {
  if (typeof document === "undefined") return null;
  const nodes = document.querySelectorAll<HTMLElement>("[data-status-id]");
  for (const node of nodes) {
    if (node.getBoundingClientRect().bottom > 0) return node.dataset.statusId ?? null;
  }
  return null;
}

function scrollToStatusAnchor(anchorId: string | null, fallbackY: number) {
  const apply = () => {
    if (anchorId) {
      const el = document.querySelector<HTMLElement>(`[data-status-id="${CSS.escape(anchorId)}"]`);
      if (el) {
        window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top);
        return;
      }
    }
    window.scrollTo(0, fallbackY);
  };
  requestAnimationFrame(() => requestAnimationFrame(apply));
}

/**
 * Force the window to a scroll position immediately. If the browser/Next.js
 * resets the scroll during navigation, a temporary scroll guard re-applies it
 * once the wrong position is observed. No timers: the guard is cancelled by a
 * newer restore (token) or removed after a few animation frames.
 */
let scrollToken = 0;

function forceScroll(y: number) {
  const token = ++scrollToken;
  const apply = () => {
    if (token !== scrollToken) return;
    window.scrollTo(0, y);
  };

  apply();

  const onScroll = () => {
    if (token !== scrollToken) return;
    const wrong = y === 0 ? window.scrollY !== 0 : window.scrollY === 0;
    if (wrong) {
      apply();
      window.removeEventListener("scroll", onScroll);
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  let frames = 0;
  const stop = () => {
    frames++;
    if (token !== scrollToken || frames >= 12) {
      window.removeEventListener("scroll", onScroll);
    } else {
      requestAnimationFrame(stop);
    }
  };
  requestAnimationFrame(stop);
}

// Restore a remembered scroll offset, defended against a browser/Next.js
// scroll-to-top running after ours.
function restoreScroll(y: number) {
  forceScroll(y);
}

// Force the window back to the top, defended against a browser/Next.js scroll
// restore running after ours (the mirror of restoreScroll, but for offset 0).
function resetScrollToTop() {
  forceScroll(0);
}

export function useTimelineCache<T extends { id: string; created_at?: string }>(
  key: string,
  fetchPage: (maxId?: string) => Promise<FetchPageResult<T>>,
  options: UseTimelineCacheOptions<T> = {}
): {
  statuses: T[];
  setStatuses: Dispatch<SetStateAction<T[]>>;
  loading: boolean;
  setLoading: Dispatch<SetStateAction<boolean>>;
  loadingMore: boolean;
  setLoadingMore: Dispatch<SetStateAction<boolean>>;
  hasMore: boolean;
  setHasMore: Dispatch<SetStateAction<boolean>>;
  seenIdsRef: RefObject<Set<string>>;
  loadMore: () => void;
  refresh: () => Promise<void>;
  catchUp: () => Promise<void>;
} {
  const initial = getTimelineCache<T>(key);
  const [statuses, setStatuses] = useState<T[]>(initial?.items ?? []);
  const [loading, setLoading] = useState(!initial?.ready);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initial?.hasMore ?? true);
  const seenIdsRef = useRef<Set<string>>(new Set(initial?.items.map((s) => s.id) ?? []));
  // Deepest status fetched contiguously from the top (see `TimelineCacheEntry.cursor`).
  const cursorRef = useRef<string | null>(
    initial?.cursor ?? initial?.items[initial.items.length - 1]?.id ?? null
  );
  // How many items the last page carried: a full page of already-known
  // statuses is pagination reaching the restored cache, not the end.
  const pageSizeRef = useRef(0);

  const keyRef = useRef(key);
  const prevKeyRef = useRef(key);
  const fetchPageRef = useRef(fetchPage);
  const optionsRef = useRef(options);
  const statusesRef = useRef(statuses);
  const hasMoreRef = useRef(hasMore);
  const loadingMoreRef = useRef(loadingMore);
  // Which feed the current `statuses` state belongs to. Guards the cache-sync
  // effect (below) from writing the previous feed's items into the new key's
  // cache entry while a tab switch's load is still pending.
  const loadedKeyRef = useRef(key);

  // Feed cache cap (instance limit). Read through a ref so the load effect —
  // which must only re-run on a key change — never depends on the limits
  // object, while every write still applies the current value.
  const limits = useLimits();
  const cacheMaxItemsRef = useRef(limits.timelineCacheMaxItems);
  useEffect(() => {
    cacheMaxItemsRef.current = limits.timelineCacheMaxItems;
  }, [limits.timelineCacheMaxItems]);

  // Keep the latest values available to stable callbacks without re-creating them
  useEffect(() => {
    keyRef.current = key;
    fetchPageRef.current = fetchPage;
    optionsRef.current = options;
    statusesRef.current = statuses;
    hasMoreRef.current = hasMore;
    loadingMoreRef.current = loadingMore;
  }, [key, fetchPage, options, statuses, hasMore, loadingMore]);

  // Loads the first page, or restores a cached feed for the active key. Runs on
  // mount and whenever the key changes (e.g. switching local/federated tabs).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (cancelled) return;
      // From this point on `statuses` belongs to the new key, so the cache-sync
      // effect may write it under the new key (and must not under the old one).
      loadedKeyRef.current = key;
      const resetOnEntry = optionsRef.current.resetScrollOnEntry === true;
      const tabSwitch = prevKeyRef.current !== key;
      // Persist the feed we are leaving before switching keys: a fast switch
      // could otherwise drop the last status/scroll update, and events that
      // arrive during the transition would have nowhere to go. Skip the scroll
      // write when the window is still at the top so we don't clobber a
      // remembered offset with 0.
      if (tabSwitch && loadedKeyRef.current === prevKeyRef.current) {
        const prevEntry = getTimelineCache<T>(prevKeyRef.current);
        if (prevEntry) {
          setTimelineCache(prevKeyRef.current, {
            ...prevEntry,
            items: statusesRef.current,
            hasMore: hasMoreRef.current,
            scrollY: window.scrollY > 0 ? window.scrollY : prevEntry.scrollY,
            anchorId: topVisibleStatusId() ?? prevEntry.anchorId ?? null,
            cursor: cursorRef.current ?? prevEntry.cursor ?? null,
          }, cacheMaxItemsRef.current);
        }
      }
      prevKeyRef.current = key;
      const cached = getTimelineCache<T>(key);
      // A history traversal restores the feed that actually has cached content.
      // Only that feed consumes the flag, so a feed mounting during the
      // transition with nothing to restore (e.g. a fresh tag/other page) can't
      // steal the restore intent from the real timeline.
      const historyRestore = restoredOnHistoryTraversal && cached?.ready === true;
      if (historyRestore) restoredOnHistoryTraversal = false;
      // A fresh entry into a reset-on-entry feed starts at the top: discard the
      // remembered offset and force the scroll so a lingering browser scroll
      // cannot leave us scrolled down. Returning via back/forward (history
      // traversal) or switching tabs must NOT reset — those restore the offset.
      if (resetOnEntry && !tabSwitch && !historyRestore) {
        const entry = getTimelineCache(key);
        if (entry) entry.scrollY = 0;
        resetScrollToTop();
      }
      const refetchOnMount = optionsRef.current.refetchOnMount === true;
      // Position this feed should end up at: its own remembered offset, or the
      // top when it has no usable cache. Enforced on tab switches (and history
      // traversals); the initial mount leaves the browser's scroll alone.
      const targetY = cached?.ready ? (cached.scrollY ?? 0) : 0;

      // Each feed keeps its own scroll position: a tab switch restores the new
      // feed's remembered offset (or starts at the top when it has none) instead
      // of inheriting the previous feed's. History traversals restore too.
      const shouldRestore = historyRestore || tabSwitch;

      // `!refetchOnMount` only: a fresh cache is restored instantly, but feeds
      // that opt into refetchOnMount must still fetch in the background and
      // reconcile deletions — a history traversal (back from a status) used to
      // short-circuit here, so auto-deleted statuses stayed in the cached feed
      // until a full reload.
      if (cached?.ready && isTimelineCacheFresh(cached) && !tabSwitch && !refetchOnMount) {
        // Mount or history traversal with a fresh cache: restore instantly,
        // nothing to refetch yet. A tab switch never short-circuits here —
        // switching feeds is an explicit request to see the latest content, so
        // the (fresh) cache is shown immediately and refreshed in the
        // background below (new posts appear even if the stream missed them).
        // Feeds that opt into refetchOnMount still skip the short-circuit on a
        // fresh mount so they catch up on posts that arrived while the page was
        // closed — but a history traversal (back from a status detail) restores
        // the exact scroll offset and must not refetch/re-anchor.
        setStatuses(cached.items);
        setHasMore(cached.hasMore);
        setLoading(false);
        if (shouldRestore) {
          // Synchronous so the feed renders already at its own offset instead of
          // flashing the previous feed's scroll position.
          if (tabSwitch) window.scrollTo(0, targetY);
          restoreScroll(targetY);
        }
        return;
      }

      // Only a `ready` entry is safe to restore: a partially-initialized one
      // (e.g. written by a previous in-flight load) must not be shown.
      if (cached?.ready) {
        setStatuses(cached.items);
        setHasMore(cached.hasMore);
        setLoading(false);
        if (shouldRestore) {
          if (tabSwitch) window.scrollTo(0, targetY);
          restoreScroll(targetY);
        }
      } else {
        setStatuses([]);
        setHasMore(true);
        setLoading(true);
        // A feed opened for the first time starts at the top instead of keeping
        // the previous feed's scroll offset.
        if (tabSwitch) window.scrollTo(0, 0);
      }

      // No fallback to `items[0]`: anchoring to the feed's first item scrolls to
      // the top. Without a captured anchor the remembered offset is used.
      const anchorId = historyRestore ? (cached?.anchorId ?? null) : null;
      const fallbackY = historyRestore ? targetY : 0;
      (async () => {
        try {
          const result = await fetchPageRef.current();
          if (cancelled) return;
          // Scrolled away from the top, a background refetch must not push new
          // statuses into the visible feed: hand them to the caller (the pill)
          // instead, so returning from a status detail keeps the exact position.
          // The fetched page is contiguous from its newest status down to its
          // oldest. If that oldest is not in the feed, everything between it
          // and the feed's top was never downloaded (the reader was away):
          // keep fetching the pages that follow before the cached statuses, so
          // the feed doesn't jump from the new posts straight into yesterday's
          // with the statuses in between missing.
          const feedIds = new Set(statusesRef.current.map((s) => s.id));
          const onDeferred = optionsRef.current.onDeferredItems;
          const scrolledAway = typeof window !== "undefined" && (window.scrollY ?? 0) > NEW_STATUSES_TOP_OFFSET;
          let fetched = result.items;
          let fetchedOldest = fetched[fetched.length - 1]?.id ?? null;
          if (fetched.length > 0) pageSizeRef.current = fetched.length;
          const gap = fetchedOldest !== null && !feedIds.has(fetchedOldest);
          if (gap && !(onDeferred && scrolledAway)) {
            for (let page = 0; page < MAX_GAP_PAGES; page++) {
              const next = await fetchPageRef.current(fetchedOldest!);
              if (cancelled || next.items.length === 0) break;
              fetched = [...fetched, ...next.items];
              const nextOldest = next.items[next.items.length - 1]?.id ?? null;
              if (!nextOldest) break;
              // The cursor is always the deepest page fetched, whether or not
              // this one reached the cached window.
              fetchedOldest = nextOldest;
              if (feedIds.has(nextOldest)) break;
            }
          }
          if (optionsRef.current.replaceOnRefetch === true || gap) {
            // Pagination resumes below the deepest page fetched here (the rest
            // of the gap, when the bound above stopped early).
            cursorRef.current = fetchedOldest;
          }

          let incoming = fetched;
          if (onDeferred && scrolledAway) {
            const prevItems = statusesRef.current;
            const known = new Set(prevItems.map((s) => s.id));
            const head = prevItems[0]?.created_at ?? "";
            const deferred = incoming.filter(
              (item) => !known.has(item.id) && (!head || !item.created_at || item.created_at > head)
            );
            if (deferred.length > 0) {
              const deferredIds = new Set(deferred.map((item) => item.id));
              incoming = incoming.filter((item) => !deferredIds.has(item.id));
              onDeferred(deferred);
            }
          }
          setStatuses((prev) => {
            // Merge with the canonical newest-first order and never let an
            // empty result wipe a cached feed (a transient failure returns an
            // empty page; the cached items must survive it). Membership feeds
            // (bookmarks/favourites) replace instead: the server page is
            // authoritative for what still belongs to the feed.
            const merged = optionsRef.current.replaceOnRefetch === true
              ? result.items
              // Deleted statuses disappear from the server page: without this
              // reconciliation the merge kept serving them from the cache
              // forever (auto-deleted posts stayed in the timeline). Only the
              // re-fetched window is reconciled; later pages and streamed
              // items newer than the window are preserved.
              : mergeTimelineItems(incoming, pruneMissingFromWindow(incoming, prev));
            setTimelineCache(key, {
              items: merged,
              hasMore: result.hasMore,
              scrollY: cached?.scrollY ?? 0,
              fetchedAt: Date.now(),
              ready: true,
              cursor: cursorRef.current,
            }, cacheMaxItemsRef.current);
            return merged;
          });
          setHasMore(result.hasMore);
          setLoading(false);
          if (historyRestore) scrollToStatusAnchor(anchorId, fallbackY);
        } catch {
          if (!cancelled) setLoading(false);
        }
      })();
    };
    Promise.resolve().then(load);
    return () => {
      cancelled = true;
    };
  }, [key]);

// Track the window scroll position so it survives unmount (navigation away).
// The value is written synchronously on every scroll so it is always current,
// and re-saved on unmount (guarded against Next.js resetting it to 0 mid
// navigation).
useIsomorphicLayoutEffect(() => {
  const onScroll = () => {
    const entry = getTimelineCache(keyRef.current);
    if (entry) entry.scrollY = window.scrollY;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    window.removeEventListener("scroll", onScroll);
    const entry = getTimelineCache(keyRef.current);
    if (entry) {
      if (window.scrollY > 0) entry.scrollY = window.scrollY;
      entry.anchorId = topVisibleStatusId() ?? entry.anchorId ?? null;
    }
  };
}, []);

  // `seenIds` is always derived from the visible items: storing it separately
  // let it drift from the feed (an id marked "seen" but absent from the items
  // made streaming drop statuses). The merge helper dedupes by id anyway, so
  // this set is only a fast-path filter for streamed events.
  useEffect(() => {
    seenIdsRef.current = new Set(statuses.map((s) => s.id));
  }, [statuses]);

  // Keep the cache in sync with the live statuses (streaming, favs, edits…).
  // Skip while a tab switch is in flight: at that moment `statuses` still holds
  // the previous feed's items and writing them into the new key's entry would
  // corrupt it (the load effect then restores the wrong feed).
  useEffect(() => {
    if (loadedKeyRef.current !== key) return;
    const prev = getTimelineCache<T>(key);
    setTimelineCache(key, {
      items: statuses,
      hasMore,
      scrollY: prev?.scrollY ?? 0,
      fetchedAt: prev?.fetchedAt ?? Date.now(),
      ready: prev?.ready ?? false,
      cursor: cursorRef.current ?? prev?.cursor ?? null,
    }, cacheMaxItemsRef.current);
  }, [key, statuses, hasMore]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    // The cursor, never the feed's last item: after a catch-up merge the tail
    // belongs to the restored cache, so paginating from it would jump below
    // the cached window and leave the statuses in between unloaded.
    const cursor = cursorRef.current;
    if (!cursor) return;
    // Set the ref synchronously: it only synced after a render, so fast
    // scrolling fired several overlapping pages before the guard caught up.
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await fetchPageRef.current(cursor);
      if (result.items.length === 0) {
        // Only stop paginating when the page truly has no more items. A
        // transient fetch error (empty items + hasMore=true) must keep the
        // feed retrying instead of permanently wedging the cached hasMore.
        setHasMore(result.hasMore);
        return;
      }
      // Advance the cursor to the page's oldest: it is the deepest status
      // fetched contiguously from the top.
      const nextCursor = result.items[result.items.length - 1]?.id ?? null;
      const known = new Set(statusesRef.current.map((s) => s.id));
      const hasNew = result.items.some((item) => !known.has(item.id));
      // A page of already-known statuses is pagination reaching the restored
      // cache (a prefix of the feed): the statuses below its tail were never
      // cached, so it keeps walking. Only a page that makes no progress at all
      // is the end — an empty one is handled above.
      if (!hasNew && nextCursor === cursor) {
        setHasMore(false);
        return;
      }
      pageSizeRef.current = result.items.length;
      if (nextCursor && nextCursor !== cursor) cursorRef.current = nextCursor;
      // Paged items are older than the feed tail; the canonical merge keeps
      // them ordered even if a streamed status slipped in meanwhile. Items
      // inside the fetched window that the server no longer returns were
      // deleted: drop them instead of resurrecting them from the cache.
      // Pagination window (not the feed start): only the fetched range is
      // authoritative. Using the first-page prune here wiped the whole feed.
      setStatuses((prev) => mergeTimelineItems(pruneMissingInWindow(result.items, prev), result.items));
      setHasMore(true);
    } catch {
      // Keep the current page; the next sentinel hit retries.
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [setLoadingMore, setStatuses, setHasMore]);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchPageRef.current();
      setStatuses(result.items);
      setHasMore(result.hasMore);
      setLoading(false);
      cursorRef.current = result.items[result.items.length - 1]?.id ?? null;
      setTimelineCache(keyRef.current, {
        items: result.items,
        hasMore: result.hasMore,
        scrollY: typeof window !== "undefined" ? window.scrollY : 0,
        fetchedAt: Date.now(),
        ready: true,
        cursor: cursorRef.current,
      }, cacheMaxItemsRef.current);
    } catch {
      setLoading(false);
    }
  }, [setStatuses, setHasMore, setLoading]);

  // Fetch the first page and merge any new items on top, preserving the current
  // scroll position and any items already in the feed. Used to catch up after a
  // WebSocket reconnect gap without the disruptive full replace that `refresh`
  // performs.
  const catchUp = useCallback(async () => {
    try {
      const result = await fetchPageRef.current();
      // Same gap rule as the mount fetch: a page whose oldest status is not in
      // the feed means the statuses in between were never downloaded, so
      // pagination resumes from the fetched page.
      const feedIds = new Set(statusesRef.current.map((s) => s.id));
      const fetchedOldest = result.items[result.items.length - 1]?.id ?? null;
      if (result.items.length > 0) pageSizeRef.current = result.items.length;
      if (fetchedOldest !== null && !feedIds.has(fetchedOldest)) cursorRef.current = fetchedOldest;
      setStatuses((prev) => {
        const merged = mergeTimelineItems(result.items, pruneMissingFromWindow(result.items, prev));
        setTimelineCache(keyRef.current, {
          items: merged,
          hasMore: result.hasMore,
          scrollY: getTimelineCache<T>(keyRef.current)?.scrollY ?? 0,
          fetchedAt: Date.now(),
          ready: true,
          cursor: cursorRef.current,
        }, cacheMaxItemsRef.current);
        return merged;
      });
      setHasMore(result.hasMore);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [setStatuses, setHasMore, setLoading]);

  return {
    statuses,
    setStatuses,
    loading,
    setLoading,
    loadingMore,
    setLoadingMore,
    hasMore,
    setHasMore,
    seenIdsRef,
    loadMore,
    refresh,
    catchUp,
  };
}