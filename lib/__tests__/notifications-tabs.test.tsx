import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocaleProvider } from "@/lib/i18n";

// Captures what the page hands to the timeline cache: the cache key per tab and
// the fetchPage built for the active tab.
const state = vi.hoisted(() => ({
  keys: [] as string[],
  fetchPage: null as ((maxId?: string) => Promise<{ items: unknown[]; hasMore: boolean }>) | null,
  calls: [] as string[],
}));

vi.mock("@/lib/streaming/use-timeline-cache", () => ({
  useTimelineCache: (
    key: string,
    fetchPage: (maxId?: string) => Promise<{ items: unknown[]; hasMore: boolean }>
  ) => {
    state.keys.push(key);
    state.fetchPage = fetchPage;
    return {
      statuses: [],
      setStatuses: vi.fn(),
      loading: false,
      loadingMore: false,
      hasMore: false,
      loadMore: vi.fn(),
      catchUp: vi.fn(),
    };
  },
}));
vi.mock("@/lib/streaming/use-timeline-stream", () => ({ useTimelineStream: vi.fn() }));
vi.mock("@/lib/limits-client", () => ({ useLimits: () => ({ pageSize: 20 }) }));
vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/BackToTop", () => ({ BackToTop: () => null }));

import NotificationsPage from "@/app/notifications/page";

function notificationCalls(): string[] {
  return state.calls.filter((url) => url.startsWith("/api/v1/notifications?"));
}

beforeEach(() => {
  state.keys.length = 0;
  state.calls.length = 0;
  state.fetchPage = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      state.calls.push(String(input));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    })
  );
});

describe("notifications tabs", () => {
  it("switches the mentions tab to the server-side type filter", async () => {
    render(
      <LocaleProvider>
        <NotificationsPage />
      </LocaleProvider>
    );

    expect(state.keys).toContain("notifications");
    await state.fetchPage!();
    expect(notificationCalls().at(-1)).toBe("/api/v1/notifications?limit=20");

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["All", "Mentions"]);
    fireEvent.click(tabs[1]);

    // Its own cache entry, and the fetch carries the tab's filter.
    expect(state.keys).toContain("notifications:mentions");
    await state.fetchPage!();
    expect(notificationCalls().at(-1)).toBe(
      "/api/v1/notifications?limit=20&types%5B%5D=mention&types%5B%5D=direct&types%5B%5D=encrypted"
    );
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe("true");
  });

  it("marks the active tab and starts on the unfiltered feed", () => {
    render(
      <LocaleProvider>
        <NotificationsPage />
      </LocaleProvider>
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
  });
});
