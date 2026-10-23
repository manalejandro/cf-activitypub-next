"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  handleStatusStreamEvent,
  mergeTimelineItems,
  updateStatusInCache,
  type TimelineItem,
} from "./timeline-cache";
import { fetchBlockedAccounts, statusTouchesBlocked, type BlockedAccounts, type StreamedStatus } from "./blocked-accounts";

/** Distance from the top that still counts as "at the top" (px). */
export const NEW_STATUSES_TOP_OFFSET = 120;

export interface NewStatusesBuffer<T = TimelineItem> {
  /** How many statuses wait behind the pill (streamed or caught up). */
  pendingCount: number;
  /** Merge the buffered statuses into the feed and jump to the top. */
  reveal: () => void;
  /**
   * Queue statuses the feed did not show yet — used by the timeline cache for
   * what a background refetch brought in while the reader was scrolled away.
   */
  queueItems: (items: T[]) => void;
  /** Feed one streaming event; true when this module handled it. */
  handleStreamEvent: (event: string, payload: string) => boolean;
}

/**
 * Streaming buffer shared by every timeline. At the top of the feed new
 * statuses merge straight in (as they always did); once the reader has
 * scrolled away they queue behind an "N new statuses" pill so the feed never
 * jumps under their finger. Pressing the pill — or scrolling back to the top —
 * flushes the queue through `mergeTimelineItems`.
 *
 * The queue belongs to **one feed**: `resetKey` (the same key the timeline
 * cache uses) drops it the moment the reader switches feeds, so the local and
 * federated tabs can never reveal each other's statuses.
 */
export function useNewStatusesBuffer<T extends TimelineItem>(
  setItems: Dispatch<SetStateAction<T[]>>,
  seenIdsRef: MutableRefObject<Set<string>>,
  resetKey?: string
): NewStatusesBuffer<T> {
  const [pendingCount, setPendingCount] = useState(0);
  // Which feed the counter belongs to: after a tab switch the display derives
  // to 0 without a state write from an effect (state must not be set there).
  const [pendingFeed, setPendingFeed] = useState<string | undefined>(resetKey);
  const pendingRef = useRef<T[]>([]);
  const pendingFeedRef = useRef<string | undefined>(resetKey);
  const atTopRef = useRef(true);
  // Shared channels (public/hashtag) are one payload for every subscriber, so
  // the viewer's blocks are applied here: a blocked author — or a reply to one
  // — must never enter the feed live. Server-filtered feeds (home) are a no-op.
  const blockedRef = useRef<BlockedAccounts | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchBlockedAccounts().then((blocked) => {
      if (alive) blockedRef.current = blocked;
    });
    return () => { alive = false; };
  }, []);

  /** Drop a queue that belongs to a feed the reader has left. */
  const ensureFeed = useCallback((): boolean => {
    if (pendingFeedRef.current === resetKey) return false;
    pendingFeedRef.current = resetKey;
    pendingRef.current = [];
    return true;
  }, [resetKey]);

  /** Queue statuses not in the feed yet (dedup by id). */
  const queue = useCallback(
    (items: T[]) => {
      ensureFeed();
      const seenIds = seenIdsRef.current;
      const fresh = items.filter((item) => !seenIds.has(item.id));
      if (fresh.length === 0 && pendingRef.current.length === 0) {
        setPendingFeed(resetKey);
        setPendingCount(0);
        return;
      }
      for (const item of fresh) seenIds.add(item.id);
      pendingRef.current = [...pendingRef.current, ...fresh];
      setPendingFeed(resetKey);
      setPendingCount(pendingRef.current.length);
    },
    [ensureFeed, resetKey, seenIdsRef]
  );

  const flush = useCallback(() => {
    const stale = ensureFeed();
    const items = stale ? [] : pendingRef.current;
    pendingRef.current = [];
    setPendingFeed(resetKey);
    setPendingCount(0);
    if (items.length === 0) return;
    setItems((prev) => mergeTimelineItems(items, prev));
  }, [ensureFeed, resetKey, setItems]);

  const reveal = useCallback(() => {
    // A stale queue is not the current feed's: pressing the pill after a tab
    // switch must not pour the previous feed's statuses into the new one.
    if (pendingFeedRef.current !== resetKey || pendingRef.current.length === 0) return;
    flush();
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      /* jsdom / older browsers */
    }
  }, [flush, resetKey]);

  useEffect(() => {
    const onScroll = () => {
      const atTop = (window.scrollY ?? 0) <= NEW_STATUSES_TOP_OFFSET;
      // Back at the top: show what arrived while the reader was away.
      if (atTop && !atTopRef.current) flush();
      atTopRef.current = atTop;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [flush]);

  const handleStreamEvent = useCallback(
    (event: string, payload: string): boolean => {
      if (event === "update") {
        const blocked = blockedRef.current;
        if (blocked) {
          try {
            if (statusTouchesBlocked(JSON.parse(payload) as StreamedStatus, blocked)) return true;
          } catch { /* let the normal path report malformed payloads */ }
        }
      }
      if (event !== "update" || atTopRef.current) {
        return handleStatusStreamEvent(event, payload, setItems, seenIdsRef.current);
      }
      // Scrolled away from the top: queue the status instead of prepending it.
      try {
        const status = JSON.parse(payload) as T;
        updateStatusInCache(status);
        queue([status]);
      } catch {
        /* ignore malformed payload */
      }
      return true;
    },
    [setItems, seenIdsRef, queue]
  );

  return {
    pendingCount: pendingFeed === resetKey ? pendingCount : 0,
    reveal,
    queueItems: queue,
    handleStreamEvent,
  };
}
