import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { getObjectById, getRelayById } from "@/lib/db";
import { broadcastStatusCreatedToAudience } from "@/lib/streaming/broadcast";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastObjectDelete: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusRefresh: vi.fn().mockResolvedValue(undefined),
  broadcastStatusCreatedToAudience: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/federation", () => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
}));

const BASE = "https://local.example.test";
const RELAY_INBOX = "https://relay.example/inbox";
const RELAY_ACTOR = "https://relay.example/actor";
const FOLLOW_ID = `${BASE}/activities/relay-follow-1`;
const NOTE_ID = "https://remote.example/users/alice/statuses/1";
const ADMIN = `${BASE}/users/admin`;

const db = env.DB;

async function freshDb(): Promise<void> {
  await resetTestDatabase();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local, inbox) VALUES (?,?,?,?,?,?)")
    .bind(RELAY_ACTOR, "relay", "relay.example", "pub", 0, RELAY_INBOX)
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,?)")
    .bind("https://remote.example/users/alice", "alice", "remote.example", "pub", 0)
    .run();
}

async function seedRelay(state: string, actorUri: string | null = null): Promise<void> {
  await db
    .prepare("INSERT INTO relays (id, inbox_url, actor_uri, state, follow_activity_id) VALUES (?,?,?,?,?)")
    .bind("r1", RELAY_INBOX, actorUri, state, FOLLOW_ID)
    .run();
}

function fakeStream() {
  return {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("ok") }),
  };
}

function announceActivity() {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://relay.example/activities/announce-1",
    type: "Announce",
    actor: RELAY_ACTOR,
    object: {
      id: NOTE_ID,
      type: "Note",
      attributedTo: "https://remote.example/users/alice",
      content: "<p>hola desde el relay</p>",
      published: "2026-10-01T00:00:00Z",
      license: "https://creativecommons.org/licenses/by-sa/4.0/",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    },
  };
}

beforeEach(async () => {
  await freshDb();
  vi.mocked(broadcastStatusCreatedToAudience).mockClear();
});

describe("relay subscription answers", () => {
  it("accepts the subscription when the relay's own host answers", async () => {
    await seedRelay("pending");
    await db
      .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local, role) VALUES (?,?,?,?,?,?)")
      .bind(ADMIN, "admin", "local.example.test", "pub", 1, "admin")
      .run();

    await processInboxActivity(
      {
        id: "https://relay.example/activities/accept-1",
        type: "Accept",
        actor: RELAY_ACTOR,
        object: { id: FOLLOW_ID, type: "Follow", actor: `${BASE}/actor`, object: "https://www.w3.org/ns/activitystreams#Public" },
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    const relay = await getRelayById(db, "r1");
    expect(relay?.state).toBe("accepted");
    expect(relay?.actorUri).toBe(RELAY_ACTOR);
  });

  it("ignores an Accept from a host that does not own the relay inbox", async () => {
    await seedRelay("pending");

    await processInboxActivity(
      {
        id: "https://evil.example/activities/accept-1",
        type: "Accept",
        actor: "https://evil.example/actor",
        object: { id: FOLLOW_ID, type: "Follow", actor: `${BASE}/actor`, object: "https://www.w3.org/ns/activitystreams#Public" },
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    expect((await getRelayById(db, "r1"))?.state).toBe("pending");
  });

  it("marks the relay rejected when it refuses", async () => {
    await seedRelay("pending");

    await processInboxActivity(
      {
        id: "https://relay.example/activities/reject-1",
        type: "Reject",
        actor: RELAY_ACTOR,
        object: { id: FOLLOW_ID, type: "Follow", actor: `${BASE}/actor`, object: "https://www.w3.org/ns/activitystreams#Public" },
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    expect((await getRelayById(db, "r1"))?.state).toBe("rejected");
  });
});

describe("relayed announces", () => {
  it("stores the announced status as a normal post (no boost) and announces it", async () => {
    await seedRelay("accepted", RELAY_ACTOR);

    await processInboxActivity(announceActivity() as never, { db, baseUrl: BASE, timelineStream: fakeStream() } as never);

    const stored = await getObjectById(db, NOTE_ID);
    expect(stored?.actorId).toBe("https://remote.example/users/alice");
    expect(stored?.content).toContain("hola desde el relay");
    // FEP-6757: the license of a remote object is kept for display.
    expect(stored?.licenseUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0/");

    const announces = await db.prepare("SELECT COUNT(*) AS n FROM announces").first<{ n: number }>();
    expect(announces?.n).toBe(0);
    expect(broadcastStatusCreatedToAudience).toHaveBeenCalledTimes(1);
  });

  it("ignores announces from a disabled relay instead of boosting them", async () => {
    await seedRelay("idle");

    await processInboxActivity(announceActivity() as never, { db, baseUrl: BASE, timelineStream: fakeStream() } as never);

    expect(await getObjectById(db, NOTE_ID)).toBeNull();
    const announces = await db.prepare("SELECT COUNT(*) AS n FROM announces").first<{ n: number }>();
    expect(announces?.n).toBe(0);
    expect(broadcastStatusCreatedToAudience).not.toHaveBeenCalled();
  });

  it("drops relayed posts from a suspended instance", async () => {
    await seedRelay("accepted", RELAY_ACTOR);
    await db
      .prepare("INSERT INTO instance_domain_blocks (domain, severity) VALUES (?, 'suspend')")
      .bind("remote.example")
      .run();

    await processInboxActivity(announceActivity() as never, { db, baseUrl: BASE, timelineStream: fakeStream() } as never);

    expect(await getObjectById(db, NOTE_ID)).toBeNull();
    expect(broadcastStatusCreatedToAudience).not.toHaveBeenCalled();
  });
});
