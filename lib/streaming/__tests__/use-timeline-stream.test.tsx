import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useTimelineStream, __resetSharedStreams } from "@/lib/streaming/use-timeline-stream";

type SocketEventHandler = ((event: Event) => void) | null;

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: SocketEventHandler = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: SocketEventHandler = null;
  onerror: SocketEventHandler = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }

  close() {
    this.readyState = 3;
    this.onclose?.(new Event("close"));
  }

  send(data: string) {
    this.sent.push(data);
  }
}

function Streams({ streams }: { streams: { stream: string; events: string[] }[] }) {
  return (
    <>
      {streams.map(({ stream }, i) => (
        <StreamListener key={i} stream={stream} index={i} />
      ))}
    </>
  );
}

const received: Record<string, string[]> = {};

function StreamListener({ stream, index }: { stream: string; index: number }) {
  useTimelineStream(stream, (event) => {
    (received[`${index}:${stream}`] ??= []).push(event);
  });
  return null;
}

beforeEach(() => {
  __resetSharedStreams();
  FakeWebSocket.instances = [];
  for (const key of Object.keys(received)) delete received[key];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  // The manager is reset in the next beforeEach; just restore the globals.
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useTimelineStream shared connections", () => {
  it("reuses one socket for every listener of the same stream", () => {
    render(<Streams streams={[{ stream: "user", events: [] }, { stream: "user", events: [] }]} />);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain("stream=user");
    act(() => socket.open());
    act(() => socket.message(JSON.stringify({ event: "update", payload: "{}" })));

    expect(received["0:user"]).toEqual(["update"]);
    expect(received["1:user"]).toEqual(["update"]);
  });

  it("serves user:notification listeners from the shared user socket, notifications only", () => {
    render(<Streams streams={[{ stream: "user", events: [] }, { stream: "user:notification", events: [] }]} />);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    act(() => socket.message(JSON.stringify({ event: "update", payload: "{}" })));
    act(() => socket.message(JSON.stringify({ event: "notification", payload: "{}" })));

    expect(received["0:user"]).toEqual(["update", "notification"]);
    expect(received["1:user:notification"]).toEqual(["notification"]);
  });

  it("keeps the socket alive across a tab switch and reuses it", () => {
    const first = render(<Streams streams={[{ stream: "user", events: [] }]} />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());

    first.unmount();
    // Still connecting/open — not torn down immediately.
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);

    render(<Streams streams={[{ stream: "user", events: [] }]} />);
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => socket.message(JSON.stringify({ event: "notification", payload: "{}" })));
    expect(received["0:user"]).toEqual(["notification"]);
  });

  it("opens separate sockets for genuinely different streams", () => {
    render(<Streams streams={[{ stream: "user", events: [] }, { stream: "public:local", events: [] }]} />);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances.map((s) => s.url).sort().join(" ")).toContain("stream=public%3Alocal");
  });

  it("reconnects once and notifies every listener", () => {
    const reconnects = vi.fn();
    function ReconnectListener() {
      useTimelineStream("user", () => {}, { onReconnect: reconnects });
      return null;
    }
    render(<ReconnectListener />);
    const first = FakeWebSocket.instances[0];
    act(() => first.open());
    expect(reconnects).not.toHaveBeenCalled();

    act(() => first.close());
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => FakeWebSocket.instances[1].open());
    expect(reconnects).toHaveBeenCalledTimes(1);
  });

  it("sends keep-alive pings on the shared socket", () => {
    render(<Streams streams={[{ stream: "public", events: [] }]} />);
    const socket = FakeWebSocket.instances[0];
    act(() => socket.open());
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(socket.sent).toEqual(["ping"]);
  });
});
