import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { useNewStatusesBuffer } from "@/lib/streaming/use-new-statuses";

vi.mock("@/lib/streaming/blocked-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/streaming/blocked-accounts")>()),
  fetchBlockedAccounts: vi.fn(async () => ({
    ids: new Set(["https://remote.example/users/blocked"]),
    domains: new Set<string>(),
  })),
}));

interface Item {
  id: string;
  created_at: string;
}

let buffer: ReturnType<typeof useNewStatusesBuffer> | null = null;

function Harness() {
  const [items, setItems] = useState<Item[]>([]);
  const seen = useRef(new Set<string>());
  const api = useNewStatusesBuffer<Item>(setItems, seen);
  useEffect(() => {
    buffer = api;
  });
  return (
    <div>
      <span data-testid="count">{api.pendingCount}</span>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.id}</li>
        ))}
      </ul>
    </div>
  );
}

function streamUpdate(id: string, createdAt: string) {
  act(() => {
    buffer!.handleStreamEvent("update", JSON.stringify({ id, created_at: createdAt }));
  });
}

function setScroll(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, writable: true, configurable: true });
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

beforeEach(() => {
  buffer = null;
  setScroll(0);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

afterEach(() => {
  cleanup();
});

describe("useNewStatusesBuffer", () => {
  it("merges new statuses straight in while the reader is at the top", () => {
    render(<Harness />);
    streamUpdate("s1", "2026-09-30T10:00:00Z");
    expect(screen.getByText("s1")).toBeTruthy();
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("queues statuses behind the pill once the reader scrolls away", () => {
    render(<Harness />);
    setScroll(600);
    streamUpdate("s1", "2026-09-30T10:00:00Z");
    streamUpdate("s2", "2026-09-30T10:01:00Z");
    // Not in the feed yet: the reader keeps their place, the pill counts them.
    expect(screen.queryByText("s1")).toBeNull();
    expect(screen.getByTestId("count").textContent).toBe("2");

    act(() => buffer!.reveal());
    expect(screen.getByText("s1")).toBeTruthy();
    expect(screen.getByText("s2")).toBeTruthy();
    expect(screen.getByTestId("count").textContent).toBe("0");
    // Newest first, like every other merge.
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["s2", "s1"]);
  });

  it("flushes the queue when the reader scrolls back to the top", () => {
    render(<Harness />);
    setScroll(900);
    streamUpdate("s1", "2026-09-30T10:00:00Z");
    expect(screen.getByTestId("count").textContent).toBe("1");

    setScroll(10);
    expect(screen.getByText("s1")).toBeTruthy();
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("still applies deletes and edits immediately while scrolled", () => {
    render(<Harness />);
    streamUpdate("s1", "2026-09-30T10:00:00Z");
    setScroll(600);

    act(() => {
      buffer!.handleStreamEvent("status.update", JSON.stringify({ id: "s1", created_at: "2026-09-30T10:00:00Z", content: "editado" }));
    });
    expect(screen.getByText("s1")).toBeTruthy();

    act(() => {
      buffer!.handleStreamEvent("delete", '"s1"');
    });
    expect(screen.queryByText("s1")).toBeNull();
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("never queues the same status twice", () => {
    render(<Harness />);
    setScroll(600);
    streamUpdate("s1", "2026-09-30T10:00:00Z");
    streamUpdate("s1", "2026-09-30T10:00:00Z");
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("drops streamed statuses from blocked accounts and replies to them", async () => {
    render(<Harness />);
    // Let the viewer's block list load (shared channels are filtered client-side).
    await act(async () => {});

    act(() => {
      buffer!.handleStreamEvent("update", JSON.stringify({
        id: "blocked-author",
        created_at: "2026-09-30T10:00:00Z",
        account: { id: "https://remote.example/users/blocked" },
      }));
    });
    expect(screen.queryByText("blocked-author")).toBeNull();

    act(() => {
      buffer!.handleStreamEvent("update", JSON.stringify({
        id: "blocked-parent",
        created_at: "2026-09-30T10:01:00Z",
        account: { id: "https://ok.example/users/x" },
        in_reply_to_account_id: "https://remote.example/users/blocked",
      }));
    });
    expect(screen.queryByText("blocked-parent")).toBeNull();

    act(() => {
      buffer!.handleStreamEvent("update", JSON.stringify({
        id: "clean",
        created_at: "2026-09-30T10:02:00Z",
        account: { id: "https://ok.example/users/x" },
      }));
    });
    expect(screen.getByText("clean")).toBeTruthy();
  });
});
