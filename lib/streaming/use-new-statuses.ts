"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  handleStatusStreamEvent,
  mergeTimelineItems,
  updateStatusInCache,
  type TimelineItem,
} from "./timeline-cache";

/** Distance from the top that still counts as "at the top" (px). */
export const NEW_STATUSES_TOP_OFFSET = 120;

export interface NewStatusesBuffer {
  /** How many streamed statuses wait behind the pill. */
  pendingCount: number;
  /** Merge the buffered statuses into the feed and jump to the top. */
  reveal: () => void;
  /** Feed one streaming event; true when this module handled it. */
  handleStreamEvent: (event: string, payload: string) => boolean;
}

/**
 * Streaming buffer shared by every timeline. At the top of the feed new
 * statuses merge straight in (as they always did); once the reader has
 * scrolled away they queue behind an "N new statuses" pill so the feed never
 * jumps under their finger. Pressing the pill — or scrolling back to the top —
 * flushes the queue through `mergeTimelineItems`.
 */
export function useNewStatusesBuffer<T extends TimelineItem>(
  setItems: Dispatch<SetStateAction<T[]>>,
  seenIdsRef: MutableRefObject<Set<string>>
): NewStatusesBuffer {
  const [pendingCount, setPendingCount] = useState(0);
  const pendingRef = useRef<T[]>([]);
  const atTopRef = useRef(true);

  /** Queue statuses not in the feed yet (dedup by id). */
  const queue = useCallback(
    (items: T[]) => {
      const seenIds = seenIdsRef.current;
      const fresh = items.filter((item) => !seenIds.has(item.id));
      if (fresh.length === 0) return;
      for (const item of fresh) seenIds.add(item.id);
      pendingRef.current = [...pendingRef.current, ...fresh];
      setPendingCount(pendingRef.current.length);
    },
    [seenIdsRef]
  );

  const flush = useCallback(() => {
    const items = pendingRef.current;
    if (items.length === 0) return;
    pendingRef.current = [];
    setPendingCount(0);
    setItems((prev) => mergeTimelineItems(items, prev));
  }, [setItems]);

  const reveal = useCallback(() => {
    if (pendingRef.current.length === 0) return;
    flush();
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      /* jsdom / older browsers */
    }
  }, [flush]);

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

  return { pendingCount, reveal, handleStreamEvent };
}
