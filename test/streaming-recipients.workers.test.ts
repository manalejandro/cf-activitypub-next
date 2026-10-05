import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";
import {
  actorExclusion,
  broadcastStatusCreatedToAudience,
  eligibleLocalRecipients,
  parentExclusion,
  type DONamespace,
} from "@/lib/streaming/broadcast";

const db = env.DB;

const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;
const BOB = `${BASE}/users/bob`;
const CAROL = `${BASE}/users/carol`;
const DAVE = `${BASE}/users/dave`;
const WRITER = "https://origin.example/users/writer";
const PARENT = "https://parent.example/users/parent";
const PARENT_OBJECT = "https://parent.example/objects/1";

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

async function insertObject(id: string, actorId: string) {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, visibility, published, is_local)
       VALUES (?, 'Note', ?, 'public', '2026-01-01T00:00:00Z', 0)`
    )
    .bind(id, actorId)
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

function fakeNs() {
  const calls: { channel: string; event: string; payload: string }[] = [];
  const ns: DONamespace = {
    idFromName: () => "timeline",
    get: () => ({
      fetch: async (_input, init) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response("ok");
      },
    }),
  };
  return { ns, calls };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  await insertActor(ALICE, 1);
  await insertActor(BOB, 1);
  await insertActor(CAROL, 1);
  await insertActor(DAVE, 1);
  await insertActor(WRITER);
  await insertActor(PARENT);
});

describe("eligibleLocalRecipients", () => {
  it("drops recipients who blocked any excluded account or domain", async () => {
    await block(BOB, WRITER);
    await domainBlock(CAROL, "origin.example");
    await block(DAVE, PARENT);

    const recipients = await eligibleLocalRecipients(
      db,
      [ALICE, BOB, CAROL, DAVE],
      [
        { id: WRITER, domain: "origin.example" },
        { id: PARENT, domain: "parent.example" },
      ]
    );

    expect(recipients.sort()).toEqual([ALICE]);
  });

  it("excludes by id even when the domain is unknown", async () => {
    await block(BOB, WRITER);
    const recipients = await eligibleLocalRecipients(db, [ALICE, BOB], [{ id: WRITER, domain: null }]);
    expect(recipients).toEqual([ALICE]);
  });

  it("resolves exclusions from the actor and parent rows", async () => {
    await insertObject(PARENT_OBJECT, PARENT);
    expect(await actorExclusion(db, WRITER)).toEqual({ id: WRITER, domain: "origin.example" });
    expect(await parentExclusion(db, PARENT_OBJECT)).toEqual({ id: PARENT, domain: "parent.example" });
    expect(await parentExclusion(db, null)).toBeNull();
  });
});

describe("broadcastStatusCreatedToAudience", () => {
  it("only fans a reply out to followers who blocked neither the author nor the parent", async () => {
    await follow(ALICE, WRITER);
    await follow(BOB, WRITER);
    await follow(CAROL, WRITER);
    await follow(DAVE, WRITER);
    await block(BOB, WRITER);
    await domainBlock(CAROL, "origin.example");
    await block(DAVE, PARENT);

    const { ns, calls } = fakeNs();
    await broadcastStatusCreatedToAudience(
      db,
      ns,
      { id: "https://origin.example/objects/reply-1", visibility: "public", in_reply_to_account_id: PARENT },
      { id: WRITER, isLocal: false }
    );

    const channels = calls.map((call) => call.channel);
    expect(channels.filter((channel) => channel.startsWith("home:"))).toEqual(["home:alice"]);
    // The shared public channels still receive it: their clients filter blocks.
    expect(channels).toContain("public");
  });

  it("fans a plain status out to every follower", async () => {
    await follow(ALICE, WRITER);
    await follow(BOB, WRITER);

    const { ns, calls } = fakeNs();
    await broadcastStatusCreatedToAudience(
      db,
      ns,
      { id: "https://origin.example/objects/plain-1", visibility: "public" },
      { id: WRITER, isLocal: false }
    );

    const homes = calls.filter((call) => call.channel.startsWith("home:")).map((call) => call.channel);
    expect(homes.sort()).toEqual(["home:alice", "home:bob"]);
  });
});
