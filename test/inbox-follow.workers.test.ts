import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { getFollow } from "@/lib/db";
import { broadcastEvent, broadcastNotificationEvent } from "@/lib/streaming/broadcast";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastObjectDelete: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusRefresh: vi.fn().mockResolvedValue(undefined),
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
const LOCAL = `${BASE}/users/locked`;
const REMOTE = "https://remote.example/users/alice";
const OTHER = "https://eve.example/users/eve";
const FOLLOW_ACTIVITY = `${BASE}/activities/f1`;

const db = env.DB;

async function freshDb(): Promise<void> {
  await resetTestDatabase();
  await db
    .prepare(
      "INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, manually_approves_followers) VALUES (?,?,?,?,?,?,?)"
    )
    .bind(LOCAL, "locked", "local.example.test", "pub", "priv", 1, 1)
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,?)")
    .bind(REMOTE, "alice", "remote.example", "pub", 0)
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,?)")
    .bind(OTHER, "eve", "eve.example", "pub", 0)
    .run();
}

function fakeStream() {
  return {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("ok") }),
  };
}

async function followRow(id: string, actorId: string, targetId: string, state: string, activityId: string) {
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state, activity_id) VALUES (?,?,?,?,?)")
    .bind(id, actorId, targetId, state, activityId)
    .run();
}

async function count(id: string): Promise<number> {
  const row = await db
    .prepare("SELECT following_count FROM actors WHERE id = ?")
    .bind(id)
    .first<{ following_count: number }>();
  return row?.following_count ?? -1;
}

describe("inbound Reject/Accept for outgoing follows", () => {
  beforeEach(async () => {
    await freshDb();
    vi.mocked(broadcastEvent).mockClear();
  });

  it("undoes the optimistic count and marks the follow rejected", async () => {
    await followRow("f1", LOCAL, REMOTE, "accepted", FOLLOW_ACTIVITY);
    await db.prepare("UPDATE actors SET following_count = 1 WHERE id = ?").bind(LOCAL).run();

    await processInboxActivity(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/activities/reject-1",
        type: "Reject",
        actor: REMOTE,
        object: { id: FOLLOW_ACTIVITY, type: "Follow", actor: LOCAL, object: REMOTE },
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    expect((await getFollow(db, LOCAL, REMOTE))?.state).toBe("rejected");
    expect(await count(LOCAL)).toBe(0);
    expect(broadcastEvent).toHaveBeenCalledWith(expect.anything(), LOCAL, "relationship", { id: REMOTE });
  });

  it("does not touch counts when the rejected request was still pending", async () => {
    await followRow("f2", LOCAL, REMOTE, "pending", FOLLOW_ACTIVITY);

    await processInboxActivity(
      {
        id: "https://remote.example/activities/reject-2",
        type: "Reject",
        actor: REMOTE,
        object: { id: FOLLOW_ACTIVITY, type: "Follow", actor: LOCAL, object: REMOTE },
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    expect((await getFollow(db, LOCAL, REMOTE))?.state).toBe("rejected");
    expect(await count(LOCAL)).toBe(0);
  });

  it("ignores a Reject from an account that did not receive the follow", async () => {
    await followRow("f3", LOCAL, REMOTE, "accepted", FOLLOW_ACTIVITY);
    await db.prepare("UPDATE actors SET following_count = 1 WHERE id = ?").bind(LOCAL).run();

    await processInboxActivity(
      {
        id: "https://eve.example/activities/reject-3",
        type: "Reject",
        actor: OTHER,
        object: { id: FOLLOW_ACTIVITY, type: "Follow", actor: LOCAL, object: REMOTE },
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    expect((await getFollow(db, LOCAL, REMOTE))?.state).toBe("accepted");
    expect(await count(LOCAL)).toBe(1);
  });

  it("counts an accepted follow that was pending", async () => {
    await followRow("f4", LOCAL, REMOTE, "pending", FOLLOW_ACTIVITY);

    await processInboxActivity(
      {
        id: "https://remote.example/activities/accept-4",
        type: "Accept",
        actor: REMOTE,
        object: { id: FOLLOW_ACTIVITY, type: "Follow", actor: LOCAL, object: REMOTE },
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    expect((await getFollow(db, LOCAL, REMOTE))?.state).toBe("accepted");
    expect(await count(LOCAL)).toBe(1);
    expect(broadcastEvent).toHaveBeenCalledWith(expect.anything(), LOCAL, "relationship", { id: REMOTE });
  });
});

describe("inbound Follow for incoming requests", () => {
  beforeEach(async () => {
    await freshDb();
    vi.mocked(broadcastNotificationEvent).mockClear();
  });

  it("re-opens a previously rejected request instead of ignoring it", async () => {
    await followRow("f5", REMOTE, LOCAL, "rejected", "https://remote.example/activities/old");

    await processInboxActivity(
      {
        id: "https://remote.example/activities/follow-5",
        type: "Follow",
        actor: REMOTE,
        object: LOCAL,
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    const follow = await getFollow(db, REMOTE, LOCAL);
    expect(follow?.state).toBe("pending");
    expect(follow?.activityId).toBe("https://remote.example/activities/follow-5");

    const notif = await db
      .prepare("SELECT type FROM notifications WHERE account_id = ?")
      .bind(REMOTE)
      .first<{ type: string }>();
    expect(notif?.type).toBe("follow_request");
    expect(broadcastNotificationEvent).toHaveBeenCalledTimes(1);
  });

  it("creates the request for a brand-new follower", async () => {
    await processInboxActivity(
      {
        id: "https://remote.example/activities/follow-6",
        type: "Follow",
        actor: REMOTE,
        object: LOCAL,
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    const follow = await getFollow(db, REMOTE, LOCAL);
    expect(follow?.state).toBe("pending");
    expect(broadcastNotificationEvent).toHaveBeenCalledTimes(1);
  });

  it("does not notify again for an already-pending request", async () => {
    await followRow("f7", REMOTE, LOCAL, "pending", "https://remote.example/activities/follow-7");

    await processInboxActivity(
      {
        id: "https://remote.example/activities/follow-8",
        type: "Follow",
        actor: REMOTE,
        object: LOCAL,
      } as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    expect((await getFollow(db, REMOTE, LOCAL))?.state).toBe("pending");
    expect(broadcastNotificationEvent).not.toHaveBeenCalled();
  });
});
