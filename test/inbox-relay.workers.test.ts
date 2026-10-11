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
  // Recipient filtering is covered by streaming-recipients.workers.test.ts;
  // here every follower stays eligible.
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
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

describe("relay-forwarded activities (activity-relay sends the original Create/Update/Delete)", () => {
  const FORWARDED_NOTE = "https://remote.example/users/alice/statuses/2";

  function forwardedCreate(id = FORWARDED_NOTE) {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${id}/activity`,
      type: "Create",
      // The relay forwards the author's own activity: actor = the author,
      // signature = the relay.
      actor: "https://remote.example/users/alice",
      object: {
        id,
        type: "Note",
        attributedTo: "https://remote.example/users/alice",
        content: "<p>hola, reenviado por el relay</p>",
        published: "2026-10-11T00:00:00Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
      },
    };
  }

  it("stores a Create forwarded by an accepted relay, attributed to its author", async () => {
    await seedRelay("accepted", RELAY_ACTOR);

    await processInboxActivity(forwardedCreate() as never, {
      db,
      baseUrl: BASE,
      signingActorId: RELAY_ACTOR,
      timelineStream: fakeStream(),
    } as never);

    const stored = await getObjectById(db, FORWARDED_NOTE);
    expect(stored?.actorId).toBe("https://remote.example/users/alice");
    expect(stored?.content).toContain("reenviado por el relay");
  });

  it("ignores a forward from a relay that is not accepted", async () => {
    await seedRelay("pending", RELAY_ACTOR);

    await processInboxActivity(forwardedCreate() as never, {
      db,
      baseUrl: BASE,
      signingActorId: RELAY_ACTOR,
      timelineStream: fakeStream(),
    } as never);

    expect(await getObjectById(db, FORWARDED_NOTE)).toBeNull();
  });

  it("never lets a relay forward an activity for a local account", async () => {
    await seedRelay("accepted", RELAY_ACTOR);
    const local = forwardedCreate("https://local.example.test/objects/1");
    (local.object as { attributedTo: string }).attributedTo = `${BASE}/users/admin`;
    local.actor = `${BASE}/users/admin`;

    await processInboxActivity(local as never, {
      db,
      baseUrl: BASE,
      signingActorId: RELAY_ACTOR,
      timelineStream: fakeStream(),
    } as never);

    expect(await getObjectById(db, "https://local.example.test/objects/1")).toBeNull();
  });

  it("only forwards content activities: a cross-actor Follow is dropped", async () => {
    await seedRelay("accepted", RELAY_ACTOR);

    await processInboxActivity(
      {
        id: "https://remote.example/activities/follow-1",
        type: "Follow",
        actor: "https://remote.example/users/alice",
        object: "https://remote.example/users/bob",
      } as never,
      { db, baseUrl: BASE, signingActorId: RELAY_ACTOR, timelineStream: fakeStream() } as never
    );

    const follows = await db.prepare("SELECT COUNT(*) AS n FROM follows").first<{ n: number }>();
    expect(follows?.n).toBe(0);
  });

  it("applies the author's domain block, not the relay's", async () => {
    await seedRelay("accepted", RELAY_ACTOR);
    await db
      .prepare("INSERT INTO instance_domain_blocks (domain, severity) VALUES (?, 'suspend')")
      .bind("remote.example")
      .run();

    await processInboxActivity(forwardedCreate() as never, {
      db,
      baseUrl: BASE,
      signingActorId: RELAY_ACTOR,
      timelineStream: fakeStream(),
    } as never);

    expect(await getObjectById(db, FORWARDED_NOTE)).toBeNull();
  });
});
