// @vitest-environment node
import { describe, it, expect } from "vitest";
import { broadcastEvent, type DONamespace } from "@/lib/streaming/broadcast";

interface Event {
  channel: string;
  event: string;
  payload: string;
}

function fakeStream(): { ns: DONamespace; events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    ns: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (_url: string, init?: RequestInit) => {
          events.push(JSON.parse(String(init?.body)) as Event);
          return new Response("ok");
        },
      }),
    } as unknown as DONamespace,
  };
}

describe("broadcastEvent", () => {
  it("delivers a typed event with its payload to the actor's channel", async () => {
    const { ns, events } = fakeStream();

    await broadcastEvent(ns, "https://cf-ap.com/users/me", "relationship", {
      id: "https://remote.example/users/alice",
    });

    expect(events).toHaveLength(1);
    expect(events[0].channel).toBe("home:me");
    expect(events[0].event).toBe("relationship");
    expect(JSON.parse(events[0].payload)).toEqual({ id: "https://remote.example/users/alice" });
  });

  it("carries call signalling through the same generic emitter", async () => {
    const { ns, events } = fakeStream();

    await broadcastEvent(ns, "https://cf-ap.com/users/me", "call", {
      type: "call.incoming",
      callId: "abc",
    });

    expect(events[0].channel).toBe("home:me");
    expect(events[0].event).toBe("call");
    expect(JSON.parse(events[0].payload)).toEqual({ type: "call.incoming", callId: "abc" });
  });

  it("defaults to an empty payload", async () => {
    const { ns, events } = fakeStream();

    await broadcastEvent(ns, "https://cf-ap.com/users/me", "relationship");

    expect(JSON.parse(events[0].payload)).toEqual({});
  });
});
