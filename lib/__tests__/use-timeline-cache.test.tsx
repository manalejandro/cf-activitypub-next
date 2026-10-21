import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { clearAllTimelineCaches, getTimelineCache, setTimelineCache } from "@/lib/streaming/timeline-cache";

interface Item {
  id: string;
  created_at: string;
}

const item = (id: number, minute = id): Item => ({
  id: String(id),
  created_at: `2026-10-20T${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`,
});

const range = (from: number, to: number): Item[] =>
  Array.from({ length: from - to + 1 }, (_, i) => item(from - i));

let api: ReturnType<typeof useTimelineCache<Item>> | null = null;

function Harness({ fetchPage }: { fetchPage: (maxId?: string) => Promise<{ items: Item[]; hasMore: boolean }> }) {
  const hook = useTimelineCache<Item>("test-feed", fetchPage, { refetchOnMount: true });
  useEffect(() => {
    api = hook;
  });
  return <div data-testid="count">{hook.statuses.length}</div>;
}

beforeEach(() => {
  clearAllTimelineCaches();
  api = null;
});

describe("useTimelineCache pagination after a catch-up", () => {
  it("resumes from the fetched page when the catch-up left a gap, not from the cached tail", async () => {
    // A cached prefix from a previous session: the newest is 1000, the oldest 981.
    setTimelineCache<Item>("test-feed", {
      items: range(1000, 981),
      hasMore: true,
      scrollY: 0,
      fetchedAt: Date.now(),
      ready: true,
      cursor: "981",
    });

    const calls: (string | undefined)[] = [];
    const fetchPage = vi.fn(async (maxId?: string) => {
      calls.push(maxId);
      // The first page carries 20 statuses the cache never saw (the reader was
      // away): there is a gap between 1001 and the cached 1000.
      if (!maxId) return { items: range(1020, 1001), hasMore: true };
      // The page right below the fetched one: it fills the gap down to the cache.
      if (maxId === "1001") return { items: range(1000, 981), hasMore: true };
      return { items: [], hasMore: false };
    });

    render(<Harness fetchPage={fetchPage} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(api?.loading).toBe(false));

    // The catch-up merged the new page on top of the cache.
    expect(api!.statuses.map((s) => s.id)).toEqual([
      ...range(1020, 1001).map((s) => s.id),
      ...range(1000, 981).map((s) => s.id),
    ]);

    // The gap was closed before rendering: the fetched page plus the pages
    // that follow it, then the cached statuses — no [new] → [old] jump.
    await waitFor(() => expect(calls).toContain("1001"));
    expect(api!.statuses.map((s) => s.id)).toEqual([
      ...range(1020, 1001).map((s) => s.id),
      ...range(1000, 981).map((s) => s.id),
    ]);
    // Pagination resumes below the deepest page fetched, never from the cached
    // tail: scrolling down continues with the statuses that follow.
    await act(async () => {
      api!.loadMore();
    });
    await waitFor(() => expect(calls).toContain("981"));
    // 981 was fetched as the *next* page (from the cursor), not as a jump: the
    // call order proves it.
    expect(calls.indexOf("981")).toBeGreaterThan(calls.indexOf("1001"));
  });

  it("stops filling the gap after the bound and leaves the rest to the cursor", async () => {
    setTimelineCache<Item>("test-feed", {
      items: range(1000, 981),
      hasMore: true,
      scrollY: 0,
      fetchedAt: Date.now(),
      ready: true,
      cursor: "981",
    });

    const calls: (string | undefined)[] = [];
    // Every page is fresh (the reader was away for a long time): the gap never
    // closes, so the eager fill stops after MAX_GAP_PAGES and the cursor keeps
    // the rest for the scroll sentinel.
    const fetchPage = vi.fn(async (maxId?: string) => {
      calls.push(maxId);
      const from = maxId ? Number(maxId) - 1 : 2000;
      return { items: range(from, from - 19), hasMore: true };
    });

    render(<Harness fetchPage={fetchPage} />);
    await waitFor(() => expect(api?.loading).toBe(false));

    // The first page plus the bounded fill (5 more).
    await waitFor(() => expect(calls.length).toBe(6));
    expect(api!.statuses.length).toBe(120);
    // The deepest page fetched: 2000-19 (first), then five pages down to 1881.
    expect(getTimelineCache<Item>("test-feed")?.cursor).toBe(String(2000 - 119));
  });

  it("keeps the cursor when the fetched page connects to the feed", async () => {
    setTimelineCache<Item>("test-feed", {
      items: range(1000, 981),
      hasMore: true,
      scrollY: 0,
      fetchedAt: Date.now(),
      ready: true,
      cursor: "981",
    });

    const calls: (string | undefined)[] = [];
    const fetchPage = vi.fn(async (maxId?: string) => {
      calls.push(maxId);
      // The page overlaps the cached feed (its oldest, 985, is already there):
      // there is no gap, so pagination continues from the remembered cursor.
      if (!maxId) return { items: range(1004, 985), hasMore: true };
      return { items: [], hasMore: false };
    });

    render(<Harness fetchPage={fetchPage} />);
    await waitFor(() => expect(api?.loading).toBe(false));

    await act(async () => {
      api!.loadMore();
    });
    await waitFor(() => expect(calls.length).toBeGreaterThan(1));
    expect(calls[1]).toBe("981");
  });

  it("remembers the cursor in the cache so a restored feed keeps paginating from it", async () => {
    const fetchPage = vi.fn(async (maxId?: string) => {
      if (!maxId) return { items: range(20, 1), hasMore: true };
      if (maxId === "1") return { items: range(40, 21), hasMore: true };
      return { items: [], hasMore: false };
    });

    render(<Harness fetchPage={fetchPage} />);
    await waitFor(() => expect(api?.loading).toBe(false));

    await act(async () => {
      api!.loadMore();
    });
    await waitFor(() => expect(fetchPage).toHaveBeenCalledWith("1"));
    await waitFor(() => expect(getTimelineCache<Item>("test-feed")?.cursor).toBe("21"));
  });
});
