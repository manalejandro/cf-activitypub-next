// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { getFollow } from "@/lib/db";
import { broadcastRelationshipChange, broadcastNotificationEvent } from "@/lib/streaming/broadcast";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastRelationshipChange: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastCallEvent: vi.fn().mockResolvedValue(undefined),
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

/** Minimal D1 adapter backed by node:sqlite (in-memory, schema loaded). */
class D1Adapter {
  private sql = new DatabaseSync(":memory:");

  constructor(schemaSql: string) {
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(schemaSql);
  }

  async batch(statements: { run(): Promise<D1Result> }[]): Promise<D1Result[]> {
    this.sql.exec("BEGIN");
    try {
      const results: D1Result[] = [];
      for (const s of statements) results.push(await s.run());
      this.sql.exec("COMMIT");
      return results;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }

  prepare(query: string) {
    const stmt = this.sql.prepare(query);
    return {
      bind(...params: unknown[]) {
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
        return {
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
            const rows = stmt.all(...(bound as never[])) as unknown as T[];
            return { results: rows, success: true, meta: {} };
          },
          async first<T = unknown>(): Promise<T | null> {
            const row = stmt.get(...(bound as never[])) as unknown as T | undefined;
            return row ?? null;
          },
          async run(): Promise<D1Result> {
            const info = stmt.run(...(bound as never[]));
            return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
          },
        };
      },
      async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
        const rows = stmt.all() as unknown as T[];
        return { results: rows, success: true, meta: {} };
      },
      async first<T = unknown>(): Promise<T | null> {
        const row = stmt.get() as unknown as T | undefined;
        return row ?? null;
      },
      async run(): Promise<D1Result> {
        const info = stmt.run();
        return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
      },
    };
  }
}

const BASE = "https://local.example.test";
const LOCAL = `${BASE}/users/locked`;
const REMOTE = "https://remote.example/users/alice";
const OTHER = "https://eve.example/users/eve";
const FOLLOW_ACTIVITY = `${BASE}/activities/f1`;

let db: D1Database;

async function freshDb(): Promise<D1Database> {
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  const adapter = new D1Adapter(schema);
  const d = adapter as unknown as D1Database;
  await d
    .prepare(
      "INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, manually_approves_followers) VALUES (?,?,?,?,?,?,?)"
    )
    .bind(LOCAL, "locked", "local.example.test", "pub", "priv", 1, 1)
    .run();
  await d
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,?)")
    .bind(REMOTE, "alice", "remote.example", "pub", 0)
    .run();
  await d
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,?)")
    .bind(OTHER, "eve", "eve.example", "pub", 0)
    .run();
  return d;
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
    db = await freshDb();
    vi.mocked(broadcastRelationshipChange).mockClear();
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
    expect(broadcastRelationshipChange).toHaveBeenCalledTimes(1);
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
    expect(broadcastRelationshipChange).toHaveBeenCalledTimes(1);
  });
});

describe("inbound Follow for incoming requests", () => {
  beforeEach(async () => {
    db = await freshDb();
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
