import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { clearAllTimelineCaches, getTimelineCache } from "@/lib/streaming/timeline-cache";

// The cap travels from the instance limits (default 1000) into every cache
// write; 2 makes the trimming observable with a handful of items.
vi.mock("@/lib/limits-client", () => ({
  useLimits: () => ({ timelineCacheMaxItems: 2 }),
}));

interface S {
  id: string;
  created_at?: string;
}

const items = (count: number): S[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    created_at: `2026-01-${String(count - i).padStart(2, "0")}T00:00:00.000Z`,
  }));

describe("useTimelineCache", () => {
  beforeEach(() => {
    clearAllTimelineCaches();
    window.scrollTo = vi.fn();
  });

  it("caps what a feed writes into the cache", async () => {
    const fetchPage = vi.fn(async () => ({ items: items(5), hasMore: false }));
    const { result } = renderHook(() => useTimelineCache("home", fetchPage));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The live feed keeps every fetched item (infinite scroll needs them)…
    expect(result.current.statuses.map((s) => s.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    // …but the cached copy is capped to the newest ones.
    const cached = getTimelineCache<S>("home");
    expect(cached?.items.map((s) => s.id)).toEqual(["s0", "s1"]);
    expect(cached?.hasMore).toBe(false);
  });

  it("defers statuses a background refetch brings in while the reader is scrolled away", async () => {
    const first = renderHook(() =>
      useTimelineCache("home", async () => ({ items: items(3), hasMore: true }), { refetchOnMount: true })
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    // Scrolled down: the user is reading a status detail, not the top.
    Object.defineProperty(window, "scrollY", { value: 800, writable: true, configurable: true });
    const deferred: S[][] = [];
    const newer = { id: "new1", created_at: "2026-02-01T00:00:00.000Z" };
    const restored = renderHook(() =>
      useTimelineCache("home", async () => ({ items: [newer, ...items(3)], hasMore: true }), {
        refetchOnMount: true,
        onDeferredItems: (batch) => deferred.push(batch),
      })
    );

    await waitFor(() => expect(deferred).toHaveLength(1));
    // Only the status newer than the feed head is deferred…
    expect(deferred[0].map((s) => s.id)).toEqual(["new1"]);
    // …and it stays out of the feed and out of the cache until revealed.
    expect(restored.result.current.statuses.map((s) => s.id)).toEqual(["s0", "s1", "s2"]);
    expect(getTimelineCache<S>("home")?.items.map((s) => s.id)).not.toContain("new1");
  });

  it("merges new statuses straight in when the refetch happens at the top", async () => {
    Object.defineProperty(window, "scrollY", { value: 0, writable: true, configurable: true });
    const deferred: S[][] = [];
    const newer = { id: "new1", created_at: "2026-02-01T00:00:00.000Z" };
    const { result } = renderHook(() =>
      useTimelineCache("home", async () => ({ items: [newer, ...items(2)], hasMore: true }), {
        onDeferredItems: (batch) => deferred.push(batch),
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(deferred).toHaveLength(0);
    expect(result.current.statuses.map((s) => s.id)).toEqual(["new1", "s0", "s1"]);
  });

  it("restores the capped feed and paginates from its tail", async () => {
    const first = renderHook(() => useTimelineCache("home", async () => ({ items: items(5), hasMore: true })));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    first.unmount();

    const fetchPage = vi.fn(async () => ({
      items: [{ id: "older", created_at: "2025-12-31T00:00:00.000Z" }],
      hasMore: false,
    }));
    const restored = renderHook(() => useTimelineCache("home", fetchPage));

    // The cache is a prefix of the live feed, so the restored page continues
    // from the last cached item without leaving a gap.
    expect(restored.result.current.statuses.map((s) => s.id)).toEqual(["s0", "s1"]);
    await act(async () => {
      await restored.result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledWith("s1");
    expect(restored.result.current.statuses.map((s) => s.id)).toEqual(["s0", "s1", "older"]);
  });
});
