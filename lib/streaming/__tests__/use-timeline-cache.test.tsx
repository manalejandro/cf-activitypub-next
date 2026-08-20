import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useEffect, useState } from "react";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { setTimelineCache, clearTimelineCache, getTimelineCache } from "@/lib/streaming/timeline-cache";

type S = { id: string };

let lastSetStatuses: ((updater: (prev: S[]) => S[]) => void) | null = null;

let fetchResults: Record<string, S[]> = {
  local: [{ id: "L1" }, { id: "L2" }],
  federated: [{ id: "F1" }, { id: "F2" }],
};

function Feed({ feedKey }: { feedKey: string }) {
  const { statuses, setStatuses } = useTimelineCache<S>(feedKey, async () => {
    const items = fetchResults[feedKey] ?? [];
    return { items, hasMore: false };
  });
  useEffect(() => {
    lastSetStatuses = setStatuses;
  });
  return (
    <div>
      {statuses.map((s) => (
        <div key={s.id} data-testid={`st-${s.id}`}>
          {s.id}
        </div>
      ))}
    </div>
  );
}

function App() {
  const [key, setKey] = useState("local");
  return (
    <div>
      <button onClick={() => setKey("federated")}>go-federated</button>
      <button onClick={() => setKey("local")}>go-local</button>
      <Feed feedKey={key} />
    </div>
  );
}

const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

beforeEach(() => {
  clearTimelineCache("local");
  clearTimelineCache("federated");
  lastSetStatuses = null;
  fetchResults = {
    local: [{ id: "L1" }, { id: "L2" }],
    federated: [{ id: "F1" }, { id: "F2" }],
  };
  scrollSpy.mockClear();
});

afterEach(() => {
  clearTimelineCache("local");
  clearTimelineCache("federated");
  lastSetStatuses = null;
  scrollSpy.mockClear();
});

function cacheLocal() {
  setTimelineCache("local", {
    items: [{ id: "L1" }, { id: "L2" }],
    hasMore: false,
    seenIds: ["L1", "L2"],
    scrollY: 800,
    fetchedAt: Date.now(),
    ready: true,
  });
}

function cacheFederated() {
  setTimelineCache("federated", {
    items: [{ id: "F1" }, { id: "F2" }],
    hasMore: false,
    seenIds: ["F1", "F2"],
    scrollY: 200,
    fetchedAt: Date.now(),
    ready: true,
  });
}

describe("useTimelineCache tab switching", () => {
  it("restores each feed's own items and scroll position when switching back and forth", async () => {
    cacheLocal();
    cacheFederated();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();
    expect(screen.queryByTestId("st-F1")).toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByText("go-federated").click();
    });
    expect(await screen.findByTestId("st-F1")).toBeTruthy();
    expect(screen.queryByTestId("st-L1")).toBeNull();
    expect(scrollSpy).toHaveBeenCalledWith(0, 200);

    scrollSpy.mockClear();
    await act(async () => {
      screen.getByText("go-local").click();
    });
    expect(await screen.findByTestId("st-L1")).toBeTruthy();
    expect(screen.queryByTestId("st-F1")).toBeNull();
    expect(scrollSpy).toHaveBeenCalledWith(0, 800);
  });

  it("starts a never-opened feed at the top instead of inheriting the previous scroll", async () => {
    cacheLocal();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    await act(async () => {
      screen.getByText("go-federated").click();
    });
    expect(await screen.findByTestId("st-F1")).toBeTruthy();
    expect(scrollSpy).toHaveBeenCalledWith(0, 0);
  });

  it("still applies streamed updates after a feed is restored from cache", async () => {
    cacheLocal();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    // Switch away and back so the local feed goes through the cached restore path.
    await act(async () => {
      screen.getByText("go-federated").click();
    });
    await screen.findByTestId("st-F1");
    await act(async () => {
      screen.getByText("go-local").click();
    });
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    // Simulate a streaming "update" event prepending a new status.
    await act(async () => {
      lastSetStatuses?.((prev) => [{ id: "LNEW" }, ...prev]);
    });
    expect(screen.getByTestId("st-LNEW")).toBeTruthy();
    const cached = getTimelineCache<{ id: string }>("local");
    expect(cached?.items.map((s) => s.id)).toContain("LNEW");
  });

  it("refetches a fresh cached feed in the background on tab switch so new posts appear", async () => {
    cacheLocal();

    render(<App />);
    expect(await screen.findByTestId("st-L1")).toBeTruthy();

    // Server now has a new local status; the cached feed must not stay frozen.
    fetchResults.local = [{ id: "LNEW" }, { id: "L1" }, { id: "L2" }];

    await act(async () => {
      screen.getByText("go-federated").click();
    });
    expect(await screen.findByTestId("st-F1")).toBeTruthy();

    await act(async () => {
      screen.getByText("go-local").click();
    });
    expect(await screen.findByTestId("st-LNEW")).toBeTruthy();
    expect(screen.getByTestId("st-L1")).toBeTruthy();
  });
});