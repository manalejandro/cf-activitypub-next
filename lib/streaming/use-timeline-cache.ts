"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  getTimelineCache,
  isTimelineCacheFresh,
  setTimelineCache,
} from "./timeline-cache";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface FetchPageResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface UseTimelineCacheOptions {
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

// Restore the window scroll position, defending against Next.js scrolling to
// the top again right after our restore (its scroll handler runs in the layout
// phase of the navigation, potentially after ours).
function restoreScroll(y: number) {
  const apply = () => window.scrollTo(0, y);
  requestAnimationFrame(() => requestAnimationFrame(apply));
  let reapplied = false;
  const guard = () => {
    if (reapplied) return;
    if (window.scrollY === 0) {
      reapplied = true;
      apply();
      window.removeEventListener("scroll", guard);
    }
  };
  window.addEventListener("scroll", guard);
  setTimeout(() => window.removeEventListener("scroll", guard), 1000);
}

// Force the window back to the top, defending against a browser/Next.js scroll
// restore running after ours (the mirror of restoreScroll, but for offset 0).
function resetScrollToTop() {
  const apply = () => window.scrollTo(0, 0);
  requestAnimationFrame(() => requestAnimationFrame(apply));
  let reapplied = false;
  const guard = () => {
    if (reapplied) return;
    if (window.scrollY !== 0) {
      reapplied = true;
      apply();
    }
  };
  window.addEventListener("scroll", guard);
  setTimeout(() => window.removeEventListener("scroll", guard), 1000);
}

export function useTimelineCache<T extends { id: string }>(
  key: string,
  fetchPage: (maxId?: string) => Promise<FetchPageResult<T>>,
  options: UseTimelineCacheOptions = {}
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
  const seenIdsRef = useRef<Set<string>>(new Set(initial?.seenIds ?? []));

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
      // Persist the feed we are leaving right away: a fast tab switch can
      // otherwise drop the last scroll event before it is written back. Skip
      // when the window is still at the top — the scroll handler has nothing
      // newer to report and we must not clobber a remembered offset with 0.
      if (tabSwitch && window.scrollY > 0) {
        const prevEntry = getTimelineCache(prevKeyRef.current);
        if (prevEntry) prevEntry.scrollY = window.scrollY;
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

      if (cached?.ready && isTimelineCacheFresh(cached) && !tabSwitch && (!refetchOnMount || historyRestore)) {
        // Mount or history traversal with a fresh cache: restore instantly,
        // nothing to refetch yet. A tab switch never short-circuits here —
        // switching feeds is an explicit request to see the latest content, so
        // the (fresh) cache is shown immediately and refreshed in the
        // background below (new posts appear even if the stream missed them).
        // Feeds that opt into refetchOnMount still skip the short-circuit on a
        // fresh mount so they catch up on posts that arrived while the page was
        // closed — but a history traversal (back from a status detail) restores
        // the exact scroll offset and must not refetch/re-anchor.
        seenIdsRef.current = new Set(cached.seenIds);
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
        seenIdsRef.current = new Set(cached.seenIds);
        setStatuses(cached.items);
        setHasMore(cached.hasMore);
        setLoading(false);
        if (shouldRestore) {
          if (tabSwitch) window.scrollTo(0, targetY);
          restoreScroll(targetY);
        }
      } else {
        seenIdsRef.current = new Set();
        setStatuses([]);
        setHasMore(true);
        setLoading(true);
        // A feed opened for the first time starts at the top instead of keeping
        // the previous feed's scroll offset.
        if (tabSwitch) window.scrollTo(0, 0);
      }

      const anchorId = historyRestore ? (cached?.items[0]?.id ?? null) : null;
      const fallbackY = historyRestore ? targetY : 0;
      (async () => {
        try {
          const result = await fetchPageRef.current();
          if (cancelled) return;
          setStatuses((prev) => {
            const known = new Set(prev.map((s) => s.id));
            const freshTop = result.items.filter((s) => !known.has(s.id));
            const merged = prev.length > 0 && result.items.length > 0 ? [...freshTop, ...prev] : result.items;
            seenIdsRef.current = new Set(merged.map((s) => s.id));
            setTimelineCache(key, {
              items: merged,
              hasMore: result.hasMore,
              seenIds: [...seenIdsRef.current],
              scrollY: cached?.scrollY ?? 0,
              fetchedAt: Date.now(),
              ready: true,
            });
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
  // useLayoutEffect ensures the cleanup runs during the layout phase — before
  // Next.js scrolls the window to the top on navigation — so the position of
  // the feed is captured before it is clobbered.
  useIsomorphicLayoutEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const entry = getTimelineCache(keyRef.current);
        if (entry) entry.scrollY = window.scrollY;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      const entry = getTimelineCache(keyRef.current);
      if (entry && window.scrollY > 0) entry.scrollY = window.scrollY;
    };
  }, []);

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
      seenIds: [...seenIdsRef.current],
      scrollY: prev?.scrollY ?? 0,
      fetchedAt: prev?.fetchedAt ?? Date.now(),
      ready: prev?.ready ?? false,
    });
  }, [key, statuses, hasMore]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    const lastId = statusesRef.current[statusesRef.current.length - 1]?.id;
    if (!lastId) return;
    setLoadingMore(true);
    try {
      const result = await fetchPageRef.current(lastId);
      if (result.items.length === 0) {
        setHasMore(false);
        return;
      }
      setStatuses((prev) => {
        const known = new Set(prev.map((s) => s.id));
        const fresh = result.items.filter((s) => !known.has(s.id));
        for (const s of fresh) seenIdsRef.current.add(s.id);
        return [...prev, ...fresh];
      });
      setHasMore(result.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }, [setLoadingMore, setStatuses, setHasMore]);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchPageRef.current();
      seenIdsRef.current = new Set(result.items.map((s) => s.id));
      setStatuses(result.items);
      setHasMore(result.hasMore);
      setLoading(false);
      setTimelineCache(keyRef.current, {
        items: result.items,
        hasMore: result.hasMore,
        seenIds: [...seenIdsRef.current],
        scrollY: 0,
        fetchedAt: Date.now(),
        ready: true,
      });
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
      setStatuses((prev) => {
        const known = new Set(prev.map((s) => s.id));
        const freshTop = result.items.filter((s) => !known.has(s.id));
        const merged = prev.length > 0 && result.items.length > 0 ? [...freshTop, ...prev] : result.items;
        seenIdsRef.current = new Set(merged.map((s) => s.id));
        setTimelineCache(keyRef.current, {
          items: merged,
          hasMore: result.hasMore,
          seenIds: [...seenIdsRef.current],
          scrollY: getTimelineCache(keyRef.current)?.scrollY ?? 0,
          fetchedAt: Date.now(),
          ready: true,
        });
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