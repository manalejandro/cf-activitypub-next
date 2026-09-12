import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { NotificationSound } from "@/components/NotificationSound";

type Listener = (e: MessageEvent) => void;

const listeners = new Map<string, Listener[]>();
const play = vi.fn().mockResolvedValue(undefined);
const pause = vi.fn();

beforeEach(() => {
  listeners.clear();
  play.mockClear();
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: (type: string, cb: Listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), cb]);
      },
      removeEventListener: (type: string, cb: Listener) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== cb));
      },
    },
  });
  vi.stubGlobal("Audio", class {
    currentTime = 0;
    play = play;
    pause = pause;
  });
});

function swMessage(data: unknown) {
  for (const cb of listeners.get("message") ?? []) cb({ data } as MessageEvent);
}

describe("NotificationSound", () => {
  it("stays silent for in-app streaming notifications", () => {
    render(<NotificationSound />);
    window.dispatchEvent(new Event("cf-ap:notification-received"));
    window.dispatchEvent(new Event("cf-ap:notification-received"));
    expect(play).not.toHaveBeenCalled();
  });

  it("plays the chime only for a Web Push that has sound enabled", () => {
    render(<NotificationSound />);
    swMessage({ type: "cfap:notification", sound: false });
    expect(play).not.toHaveBeenCalled();
    swMessage({ type: "cfap:notification", sound: true });
    expect(play).toHaveBeenCalledTimes(1);
  });
});
