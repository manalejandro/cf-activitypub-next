import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { broadcastEvent } from "@/lib/streaming/broadcast";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
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

const db = env.DB;
const BASE = "https://local.example.test";
const REMOTE_ACTOR = "https://remote.example/users/alice";
const LOCAL_ACTOR = `${BASE}/users/bob`;
const CALL_ID = "4f9a2c3d-0000-0000-0000-000000000001";

async function freshDb(): Promise<void> {
  await resetTestDatabase();
  const insertActor = db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local) VALUES (?, ?, ?, ?, ?, ?)`
  );
  await insertActor.bind(REMOTE_ACTOR, "alice", "remote.example", "key-alice", null, 0).run();
  await insertActor.bind(LOCAL_ACTOR, "bob", "local.example.test", "key-bob", "priv-bob", 1).run();
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

/** KV seeded with the call session created by the original CallOffer. */
async function makeCallKv(): Promise<ReturnType<typeof makeKv>> {
  const kv = makeKv();
  await kv.put(
    `call:${CALL_ID}`,
    JSON.stringify({ id: CALL_ID, callerId: REMOTE_ACTOR, calleeId: LOCAL_ACTOR, state: "pending" })
  );
  return kv;
}

beforeAll(async () => {
  await freshDb();
});

beforeEach(async () => {
  await freshDb();
  (broadcastEvent as ReturnType<typeof vi.fn>).mockClear();
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

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
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
    expect(broadcastEvent).not.toHaveBeenCalled();
    expect(await kv.get(`call:${CALL_ID}`)).toBeNull();
  });

  it("resolves the recipient from activity.to and broadcasts call.answered for CallAnswer", async () => {
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallAnswer", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "answer-sdp-1" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.answered");
    expect(event.callId).toBe(CALL_ID);
    expect(event.answerSdp).toBe("answer-sdp-1");
  });

  it("broadcasts call.ice with a parsed candidate for CallIceCandidate", async () => {
    const candidate = { candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallIceCandidate", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, candidate: JSON.stringify(candidate) },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
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
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it("broadcasts call.ended for CallHangup", async () => {
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallHangup") as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.ended");
    expect(event.callId).toBe(CALL_ID);
  });

  it("broadcasts call.renegotiate for CallRenegotiate (mid-call track add)", async () => {
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallRenegotiate", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "reoffer-sdp" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.renegotiate");
    expect(event.callId).toBe(CALL_ID);
    expect(event.sdp).toBe("reoffer-sdp");
  });

  it("broadcasts call.renegotiate-answer for CallRenegotiateAnswer", async () => {
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallRenegotiateAnswer", {
        object: { type: "CallSession", id: `${BASE}/calls/${CALL_ID}`, sdp: "reanswer-sdp" },
      }) as never,
      { db, baseUrl: BASE, kv, timelineStream } as never
    );

    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    const [, actorId, type, payload] = (broadcastEvent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(actorId).toBe(LOCAL_ACTOR);
    expect(type).toBe("call");
    const event = payload as Record<string, unknown>;
    expect(event.type).toBe("call.renegotiate-answer");
    expect(event.callId).toBe(CALL_ID);
    expect(event.sdp).toBe("reanswer-sdp");
  });

  it("drops call events from an actor outside the call session", async () => {
    const other = "https://evil.example/users/mallory";
    await db
      .prepare("INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local) VALUES (?,?,?,?,?,?)")
      .bind(other, "mallory", "evil.example", "key-m", null, 0)
      .run();
    const kv = await makeCallKv();
    await processInboxActivity(
      makeCallActivity("CallHangup", { actor: other, id: `${other}/activities/hangup-1` }) as never,
      { db, baseUrl: BASE, kv, timelineStream, signingActorId: other } as never
    );
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  it("processes a replayed activity id only once", async () => {
    const kv = await makeCallKv();
    const activity = makeCallActivity("CallHangup");
    const ctx = { db, baseUrl: BASE, kv, timelineStream } as never;
    await processInboxActivity(activity as never, ctx);
    await processInboxActivity(activity as never, ctx);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
  });
});