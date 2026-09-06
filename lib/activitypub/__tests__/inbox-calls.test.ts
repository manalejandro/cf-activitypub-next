// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { broadcastCallEvent } from "@/lib/streaming/broadcast";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastCallEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/federation", () => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
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

/** In-memory KV namespace (keys, optional TTL). */
function makeKv(): { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> } {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

let db: D1Database;
const BASE = "https://local.example.test";
const REMOTE_ACTOR = "https://remote.example/users/alice";
const LOCAL_ACTOR = `${BASE}/users/bob`;
const CALL_ID = "4f9a2c3d-0000-0000-0000-000000000001";

async function freshDb(): Promise<D1Database> {
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  const adapter = new D1Adapter(schema);
  const d = adapter as unknown as D1Database;
  const insertActor = d.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local) VALUES (?, ?, ?, ?, ?, ?)`
  );
  await insertActor.bind(REMOTE_ACTOR, "alice", "remote.example", "key-alice", null, 0).run();
  await insertActor.bind(LOCAL_ACTOR, "bob", "local.example.test", "key-bob", "priv-bob", 1).run();
  return d;
}

function makeCallActivity(type: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${REMOTE_ACTOR}/activities/${type.toLowerCase()}-1`,
    type,
    actor: REMOTE_ACTOR,
    to: [LOCAL_ACTOR],
    object: {
      type: "CallSession",
      id: `${BASE}/calls/${CALL_ID}`,
      callType: "video",
      sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1",
    },
    ...overrides,
  };
}

const timelineStream = {} as never;

beforeAll(async () => {
  db = await freshDb();
});

beforeEach(async () => {
  db = await freshDb();
  (broadcastCallEvent as ReturnType<typeof vi.fn>).mockClear();
});

describe("call negotiation inbox handling", () => {
  it("persists a call session and broadcasts call.incoming for CallOffer", async () => {
    const kv = makeKv();
    await processInboxActivity(makeCallActivity("CallOffer") as never, {
      db,
      baseUrl: BASE,
      kv,
      timelineStream,
      recipient: { id: LOCAL_ACTOR, username: "bob", privateKeyPem: "priv-bob" },
    } as never);

    expect(broadcastCallEvent).toHaveBeenCalledTimes(1);
    const [, username, payload] = (broadcastCallEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(username).toBe("bob");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.incoming");
    expect(event.callId).toBe(CALL_ID);
    expect(event.callType).toBe("video");
    expect(event.callerAcct).toBe("alice@remote.example");
    expect(event.offerSdp).toContain("v=0");

    // Session persisted so the callee can answer against their own instance
    const session = JSON.parse((await kv.get(`call:${CALL_ID}`))!);
    expect(session.callerId).toBe(REMOTE_ACTOR);
    expect(session.calleeId).toBe(LOCAL_ACTOR);
    expect(session.state).toBe("pending");
  });

  it("does nothing for CallOffer without a recipient (shared inbox)", async () => {
    const kv = makeKv();
    await processInboxActivity(makeCallActivity("CallOffer") as never, { db, baseUrl: BASE, kv } as never);
    expect(broadcastCallEvent).not.toHaveBeenCalled();
    expect(await kv.get(`call:${CALL_ID}`)).toBeNull();
  });

  it("resolves the recipient from activity.to and broadcasts call.answered for CallAnswer", async () => {
    await processInboxActivity(
      makeCallActivity("CallAnswer", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "answer-sdp-1" },
      }) as never,
      { db, baseUrl: BASE, timelineStream } as never
    );

    expect(broadcastCallEvent).toHaveBeenCalledTimes(1);
    const [, username, payload] = (broadcastCallEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(username).toBe("bob");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.answered");
    expect(event.callId).toBe(CALL_ID);
    expect(event.answerSdp).toBe("answer-sdp-1");
  });

  it("broadcasts call.ice with a parsed candidate for CallIceCandidate", async () => {
    const candidate = { candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    await processInboxActivity(
      makeCallActivity("CallIceCandidate", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, candidate: JSON.stringify(candidate) },
      }) as never,
      { db, baseUrl: BASE, timelineStream } as never
    );

    expect(broadcastCallEvent).toHaveBeenCalledTimes(1);
    const [, username, payload] = (broadcastCallEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(username).toBe("bob");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.ice");
    expect(event.callId).toBe(CALL_ID);
    expect(event.candidate).toEqual(candidate);
  });

  it("drops a CallIceCandidate with no candidate payload", async () => {
    await processInboxActivity(
      makeCallActivity("CallIceCandidate") as never,
      { db, baseUrl: BASE, timelineStream } as never
    );
    expect(broadcastCallEvent).not.toHaveBeenCalled();
  });

  it("broadcasts call.ended for CallHangup", async () => {
    await processInboxActivity(
      makeCallActivity("CallHangup") as never,
      { db, baseUrl: BASE, timelineStream } as never
    );

    expect(broadcastCallEvent).toHaveBeenCalledTimes(1);
    const [, username, payload] = (broadcastCallEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(username).toBe("bob");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.ended");
    expect(event.callId).toBe(CALL_ID);
  });

  it("broadcasts call.renegotiate for CallRenegotiate (mid-call track add)", async () => {
    await processInboxActivity(
      makeCallActivity("CallRenegotiate", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "reoffer-sdp" },
      }) as never,
      { db, baseUrl: BASE, timelineStream } as never
    );

    expect(broadcastCallEvent).toHaveBeenCalledTimes(1);
    const [, username, payload] = (broadcastCallEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(username).toBe("bob");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.renegotiate");
    expect(event.callId).toBe(CALL_ID);
    expect(event.sdp).toBe("reoffer-sdp");
  });

  it("broadcasts call.renegotiate-answer for CallRenegotiateAnswer", async () => {
    await processInboxActivity(
      makeCallActivity("CallRenegotiateAnswer", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "reanswer-sdp" },
      }) as never,
      { db, baseUrl: BASE, timelineStream } as never
    );

    expect(broadcastCallEvent).toHaveBeenCalledTimes(1);
    const [, username, payload] = (broadcastCallEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(username).toBe("bob");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.renegotiate-answer");
    expect(event.callId).toBe(CALL_ID);
    expect(event.sdp).toBe("reanswer-sdp");
  });
});