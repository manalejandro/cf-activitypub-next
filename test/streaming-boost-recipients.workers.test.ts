import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

const homeCalls = vi.hoisted(() => [] as { channel: string; payload: string }[]);

// Keep the real recipient filtering (eligibleLocalRecipients) and capture the
// home fan-out, so the Announce path can be asserted end to end.
vi.mock("@/lib/streaming/broadcast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/streaming/broadcast")>();
  return {
    ...actual,
    broadcastHomeStatus: vi.fn(async (_ns: unknown, actorId: string, status: unknown) => {
      homeCalls.push({ channel: `home:${actorId.split("/").pop()}`, payload: JSON.stringify(status) });
    }),
    broadcastHomeStatusUpdate: vi.fn(async () => {}),
    broadcastPublicStatus: vi.fn(async () => {}),
    broadcastStatusUpdate: vi.fn(async () => {}),
    broadcastStatusInteraction: vi.fn(async () => {}),
    broadcastStatusInteractionToLists: vi.fn(async () => {}),
    broadcastStatusRefresh: vi.fn(async () => {}),
    broadcastStatusCreatedToAudience: vi.fn(async () => {}),
    broadcastNotificationEvent: vi.fn(async () => {}),
    broadcastEvent: vi.fn(async () => {}),
    broadcastObjectDelete: vi.fn(async () => {}),
  };
});

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn(async () => {}),
}));

vi.mock("@/lib/activitypub/federation", () => ({
  deliverToInbox: vi.fn(async () => {}),
  signedGetHeaders: vi.fn(async () => ({})),
  fetchRemoteObject: vi.fn(async () => null),
}));

import { processInboxActivity } from "@/lib/activitypub/inbox";

const db = env.DB;

const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;
const BOB = `${BASE}/users/bob`;
const CAROL = `${BASE}/users/carol`;
const BOOSTY = "https://remote.example/users/boosty";
const WRITER = "https://origin.example/users/writer";
const NOTE = "https://origin.example/objects/1";

async function insertActor(id: string, isLocal = 0) {
  const url = new URL(id);
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, ?, ?, 'k', NULL, ?)`
    )
    .bind(id, url.pathname.split("/").pop(), url.hostname, isLocal)
    .run();
}

async function block(actorId: string, targetId: string) {
  await db
    .prepare("INSERT INTO blocks (id, actor_id, target_id) VALUES (?,?,?)")
    .bind(`${actorId}->${targetId}`, actorId, targetId)
    .run();
}

async function domainBlock(actorId: string, domain: string) {
  await db
    .prepare("INSERT INTO domain_blocks (id, actor_id, domain) VALUES (?,?,?)")
    .bind(`${actorId}:${domain}`, actorId, domain)
    .run();
}

async function follow(actorId: string, targetId: string) {
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?,?,?,'accepted')")
    .bind(`${actorId}->${targetId}`, actorId, targetId)
    .run();
}

function fakeStream() {
  return {
    idFromName: () => ({}),
    get: () => ({ fetch: async () => new Response("ok") }),
  };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  homeCalls.length = 0;
  await insertActor(ALICE, 1);
  await insertActor(BOB, 1);
  await insertActor(CAROL, 1);
  await insertActor(BOOSTY);
  await insertActor(WRITER);
  await follow(ALICE, BOOSTY);
  await follow(BOB, BOOSTY);
  await follow(CAROL, BOOSTY);
  await block(BOB, WRITER);
  await domainBlock(CAROL, "origin.example");
});

function announceActivity() {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://remote.example/activities/announce-1",
    type: "Announce",
    actor: BOOSTY,
    object: {
      id: NOTE,
      type: "Note",
      attributedTo: WRITER,
      content: "<p>hola</p>",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      published: "2026-01-01T00:00:00Z",
    },
  };
}

describe("Announce home fan-out", () => {
  it("skips followers who blocked the boosted author or its domain", async () => {
    await processInboxActivity(
      announceActivity() as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    const channels = homeCalls.map((call) => call.channel);
    expect(channels).toContain("home:alice");
    expect(channels).not.toContain("home:bob");
    expect(channels).not.toContain("home:carol");
  });

  it("delivers the boost to every follower when nobody is blocked", async () => {
    await db.prepare("DELETE FROM blocks").run();
    await db.prepare("DELETE FROM domain_blocks").run();

    await processInboxActivity(
      announceActivity() as never,
      { db, baseUrl: BASE, timelineStream: fakeStream() } as never
    );

    const channels = homeCalls.map((call) => call.channel).sort();
    expect(channels).toEqual(["home:alice", "home:bob", "home:carol"]);
  });
});
