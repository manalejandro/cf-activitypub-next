// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
  mergeTimelineItems,
  handleStatusStreamEvent,
  setTimelineCache,
  getTimelineCache,
  clearAllTimelineCaches,
} from "@/lib/streaming/timeline-cache";

interface S {
  id: string;
  created_at?: string;
  content?: string;
}

const s = (id: string, created_at?: string): S => ({ id, created_at });

/** Minimal Dispatch<SetStateAction<S[]>> stand-in. */
function stateHolder(initial: S[]) {
  let items = initial;
  const setItems = ((action: unknown) => {
    items = typeof action === "function" ? (action as (p: S[]) => S[])(items) : action as S[];
  }) as never;
  return { setItems, get items() { return items; } };
}

describe("mergeTimelineItems", () => {
  it("dedupes by id and orders newest-first by created_at", () => {
    const a = [s("1", "2026-01-01T10:00:00Z"), s("2", "2026-01-01T12:00:00Z")];
    const b = [s("3", "2026-01-01T11:00:00Z"), s("1", "2026-01-01T10:00:00Z")];
    expect(mergeTimelineItems(a, b).map((x) => x.id)).toEqual(["2", "3", "1"]);
  });

  it("keeps insertion order for items without a date", () => {
    expect(mergeTimelineItems([s("x"), s("y")]).map((x) => x.id)).toEqual(["x", "y"]);
  });
});

describe("handleStatusStreamEvent", () => {
  beforeEach(() => clearAllTimelineCaches());

  it("inserts a late-arriving status at its chronological position, not first", () => {
    const holder = stateHolder([s("new", "2026-01-01T12:00:00Z")]);
    const seen = new Set(["new"]);

    handleStatusStreamEvent("update", JSON.stringify(s("old", "2026-01-01T09:00:00Z")), holder.setItems, seen);

    expect(holder.items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("does not duplicate a status already present", () => {
    const holder = stateHolder([s("1", "2026-01-01T12:00:00Z")]);
    const seen = new Set(["1"]);

    handleStatusStreamEvent("update", JSON.stringify(s("1", "2026-01-01T12:00:00Z")), holder.setItems, seen);

    expect(holder.items.map((i) => i.id)).toEqual(["1"]);
  });

  it("delete removes the status and purges it from every cached feed", () => {
    setTimelineCache("home", {
      items: [s("1", "2026-01-01T12:00:00Z")],
      hasMore: true,
      scrollY: 0,
      fetchedAt: Date.now(),
      ready: true,
    });
    const holder = stateHolder([s("1", "2026-01-01T12:00:00Z"), s("2", "2026-01-01T11:00:00Z")]);
    const seen = new Set(["1", "2"]);

    handleStatusStreamEvent("delete", '"1"', holder.setItems, seen);

    expect(holder.items.map((i) => i.id)).toEqual(["2"]);
    expect(seen.has("1")).toBe(false);
    expect(getTimelineCache<S>("home")?.items).toEqual([]);
  });
});
