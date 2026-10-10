// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  updateRelay: vi.fn(async () => {}),
  getRelayById: vi.fn(async (): Promise<unknown> => null),
  enqueueDeliveries: vi.fn(async () => {}),
  getInstanceSigner: vi.fn(
    async (): Promise<{ id: string; privateKeyPem: string } | null> => ({
      id: "https://cf-ap.com/users/guardian",
      privateKeyPem: "priv",
    })
  ),
}));

vi.mock("@/lib/db", () => ({
  updateRelay: mocks.updateRelay,
  getRelayById: mocks.getRelayById,
  listRelays: vi.fn(async () => []),
}));
vi.mock("@/lib/activitypub/queue", () => ({ enqueueDeliveries: mocks.enqueueDeliveries }));
vi.mock("@/lib/activitypub/federation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/federation")>()),
  getInstanceSigner: mocks.getInstanceSigner,
}));

import {
  disableRelay,
  enableRelay,
  normalizeRelayInbox,
  relayMatchesActor,
  acceptedRelayInboxes,
  withRelayInboxes,
} from "@/lib/activitypub/relays";
import type { LocalRelay } from "@/lib/types";

const BASE = "https://cf-ap.com";
const SIGNER = "https://cf-ap.com/users/guardian";
const RELAY: LocalRelay = {
  id: "r1",
  inboxUrl: "https://relay.example/inbox",
  actorUri: null,
  state: "idle",
  followActivityId: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInstanceSigner.mockResolvedValue({ id: SIGNER, privateKeyPem: "priv" });
  mocks.getRelayById.mockResolvedValue({ ...RELAY, state: "pending" });
});

describe("normalizeRelayInbox", () => {
  it("accepts a public https inbox and drops the fragment", () => {
    expect(normalizeRelayInbox(" https://relay.example/inbox#x ")).toBe("https://relay.example/inbox");
  });

  it("rejects plain http, private hosts and junk", () => {
    expect(normalizeRelayInbox("http://relay.example/inbox")).toBeNull();
    expect(normalizeRelayInbox("https://127.0.0.1/inbox")).toBeNull();
    expect(normalizeRelayInbox("https://localhost/inbox")).toBeNull();
    expect(normalizeRelayInbox("not a url")).toBeNull();
    expect(normalizeRelayInbox("")).toBeNull();
  });
});

describe("relayMatchesActor", () => {
  it("matches by recorded actor URI, inbox URL or host", () => {
    expect(relayMatchesActor({ ...RELAY, actorUri: "https://relay.example/actor" }, { id: "https://relay.example/actor" })).toBe(true);
    expect(relayMatchesActor(RELAY, { id: "https://relay.example/actor", inbox: "https://relay.example/inbox" })).toBe(true);
    expect(relayMatchesActor(RELAY, { id: "https://relay.example/actor" })).toBe(true);
    expect(relayMatchesActor(RELAY, { id: "https://evil.example/actor", inbox: "https://evil.example/inbox" })).toBe(false);
  });
});

describe("relay delivery targets", () => {
  function fakeDb(rows: { inbox_url: string }[]) {
    return {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
    };
  }

  it("returns the inbox of every accepted relay", async () => {
    const inboxes = await acceptedRelayInboxes(
      fakeDb([{ inbox_url: "https://relay.example/inbox" }, { inbox_url: "https://relay2.example/inbox" }]) as never
    );
    expect(inboxes).toEqual(["https://relay.example/inbox", "https://relay2.example/inbox"]);
  });

  it("answers no relays when the table is missing", async () => {
    const broken = {
      prepare: () => {
        throw new Error("no such table: relays");
      },
    };
    expect(await acceptedRelayInboxes(broken as never)).toEqual([]);
  });

  it("adds the relay inboxes to a public status only", async () => {
    const db = fakeDb([{ inbox_url: "https://relay.example/inbox" }]) as never;

    expect(await withRelayInboxes(db, "public", ["https://a.example/inbox"])).toEqual([
      "https://a.example/inbox",
      "https://relay.example/inbox",
    ]);
    for (const visibility of ["unlisted", "private", "direct"]) {
      expect(await withRelayInboxes(db, visibility, ["https://a.example/inbox"])).toEqual(["https://a.example/inbox"]);
    }
  });
});

describe("enableRelay", () => {
  it("sends a Follow for the public collection signed by the instance actor", async () => {
    await enableRelay({ DB: {} as never, DELIVERY_QUEUE: {} as never }, RELAY, BASE);

    expect(mocks.updateRelay).toHaveBeenCalledTimes(1);
    const [, id, patch] = mocks.updateRelay.mock.calls[0] as unknown as [unknown, string, { state: string; followActivityId: string }];
    expect(id).toBe("r1");
    expect(patch.state).toBe("pending");
    expect(patch.followActivityId).toMatch(`${BASE}/activities/`);

    expect(mocks.enqueueDeliveries).toHaveBeenCalledTimes(1);
    const [, inboxes, payload, actorId, keyId] = mocks.enqueueDeliveries.mock.calls[0] as unknown as [unknown, string[], string, string, string];
    expect(inboxes).toEqual(["https://relay.example/inbox"]);
    expect(actorId).toBe(SIGNER);
    expect(keyId).toBe(`${SIGNER}#main-key`);
    const activity = JSON.parse(payload) as { type: string; actor: string; object: string; id: string };
    expect(activity.type).toBe("Follow");
    expect(activity.actor).toBe(SIGNER);
    expect(activity.object).toBe("https://www.w3.org/ns/activitystreams#Public");
    expect(activity.id).toBe(patch.followActivityId);
  });

  it("does nothing without a local signing actor", async () => {
    mocks.getInstanceSigner.mockResolvedValue(null);
    expect(await enableRelay({ DB: {} as never }, RELAY, BASE)).toBeNull();
    expect(mocks.enqueueDeliveries).not.toHaveBeenCalled();
  });
});

describe("disableRelay", () => {
  it("sends Undo{Follow} and returns the relay to idle", async () => {
    await disableRelay(
      { DB: {} as never, DELIVERY_QUEUE: {} as never },
      { ...RELAY, state: "accepted", followActivityId: `${BASE}/activities/relay-follow-1` },
      BASE
    );

    const [, id, patch] = mocks.updateRelay.mock.calls[0] as unknown as [unknown, string, { state: string; followActivityId: null }];
    expect(id).toBe("r1");
    expect(patch).toEqual({ state: "idle", followActivityId: null });

    const [, , payload] = mocks.enqueueDeliveries.mock.calls[0] as unknown as [unknown, string[], string];
    const activity = JSON.parse(payload) as { type: string; object: { type: string; id: string; object: string }; to?: string[]; cc?: string[] };
    expect(activity.type).toBe("Undo");
    expect(activity.object.type).toBe("Follow");
    expect(activity.object.id).toBe(`${BASE}/activities/relay-follow-1`);
    expect(activity.object.object).toBe("https://www.w3.org/ns/activitystreams#Public");
    // The Undo mirrors the Follow's (empty) audience: it must not become public.
    expect(activity.to).toBeUndefined();
    expect(activity.cc).toBeUndefined();
  });

  it("does not send an Undo when nothing was subscribed", async () => {
    await disableRelay({ DB: {} as never, DELIVERY_QUEUE: {} as never }, RELAY, BASE);
    expect(mocks.enqueueDeliveries).not.toHaveBeenCalled();
    expect(mocks.updateRelay).toHaveBeenCalledTimes(1);
  });
});
