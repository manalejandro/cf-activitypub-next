import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { memo } from "react";
import { render, screen, act } from "@testing-library/react";
import { RelativeTime, formatRelativeTime } from "@/components/RelativeTime";

const BASE = new Date("2026-10-12T10:00:00.000Z").getTime();

/** ISO string `seconds` before BASE. */
function ago(seconds: number): string {
  return new Date(BASE - seconds * 1000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("counts seconds, minutes, hours and then falls back to a date", () => {
    expect(formatRelativeTime(ago(5), BASE)).toBe("5s");
    expect(formatRelativeTime(ago(59), BASE)).toBe("59s");
    expect(formatRelativeTime(ago(90), BASE)).toBe("1m");
    expect(formatRelativeTime(ago(3 * 3600), BASE)).toBe("3h");
    expect(formatRelativeTime(ago(2 * 86400), BASE)).toBe(new Date(BASE - 2 * 86400_000).toLocaleDateString());
  });

  it("never shows a negative age for a skewed clock", () => {
    expect(formatRelativeTime(new Date(BASE + 5000).toISOString(), BASE)).toBe("0s");
  });
});

describe("RelativeTime", () => {
  it("keeps ticking after the first render (the memoised-card bug)", () => {
    render(<RelativeTime iso={ago(5)} />);
    expect(screen.getByText("5s")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("6s")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText("8s")).toBeTruthy();
  });

  it("crosses the minute boundary without help", () => {
    render(<RelativeTime iso={ago(59)} />);
    expect(screen.getByText("59s")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("1m")).toBeTruthy();
  });

  it("does not re-render a memoised parent, only the label", () => {
    let parentRenders = 0;
    const Parent = memo(function Parent({ iso }: { iso: string }) {
      parentRenders += 1;
      return <div><RelativeTime iso={iso} /></div>;
    });

    render(<Parent iso={ago(5)} />);
    expect(parentRenders).toBe(1);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("8s")).toBeTruthy();
    expect(parentRenders).toBe(1);
  });

  it("shares one timer for every label on the page", () => {
    render(
      <div>
        <RelativeTime iso={ago(5)} />
        <RelativeTime iso={ago(30)} />
        <RelativeTime iso={ago(3600)} />
      </div>
    );

    // One interval, not one per component.
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops the shared timer when the last label unmounts", () => {
    const { unmount } = render(<RelativeTime iso={ago(5)} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
