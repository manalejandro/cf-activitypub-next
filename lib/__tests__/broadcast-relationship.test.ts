// @vitest-environment node
import { describe, it, expect } from "vitest";
import { broadcastRelationshipChange, type DONamespace } from "@/lib/streaming/broadcast";

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

describe("broadcastRelationshipChange", () => {
  it("notifies the local follower's user stream with the target id", async () => {
    const { ns, events } = fakeStream();

    await broadcastRelationshipChange(ns, "https://cf-ap.com/users/me", "https://remote.example/users/alice");

    expect(events).toHaveLength(1);
    expect(events[0].channel).toBe("home:me");
    expect(events[0].event).toBe("relationship");
    expect(JSON.parse(events[0].payload)).toEqual({ id: "https://remote.example/users/alice" });
  });
});
