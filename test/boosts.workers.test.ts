import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAnnounce, getActorStatuses, getHomeTimeline } from "@/lib/db";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

const db = env.DB;

const ME = "https://local.example/users/me";
const ALICE = "https://remote.example/users/alice";
const BOB = "https://other.example/users/bob";

async function insertActor(id: string, domain: string, isLocal = 0) {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, ?, ?, 'k', NULL, ?)`
    )
    .bind(id, id.split("/").pop(), domain, isLocal)
    .run();
}

async function insertObject(id: string, actorId: string, visibility: string, published: string) {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, visibility, published, is_local)
       VALUES (?, 'Note', ?, ?, ?, 0)`
    )
    .bind(id, actorId, visibility, published)
    .run();
}

async function follow(actorId: string, targetId: string) {
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?,?,?,'accepted')")
    .bind(`${actorId}->${targetId}`, actorId, targetId)
    .run();
}

function boost(actorId: string, objectId: string, id: string, createdAt: string) {
  return createAnnounce(db, { id, actorId, objectId, activityId: "", createdAt });
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  await insertActor(ME, "local.example", 1);
  await insertActor(ALICE, "remote.example");
  await insertActor(BOB, "other.example");
});

describe("home timeline boosts", () => {
  it("surfaces a boost by a followed account of a post by an unfollowed author", async () => {
    await follow(ME, ALICE);
    await insertObject("https://other.example/objects/b1", BOB, "public", "2026-01-01T00:00:00Z");
    await boost(ALICE, "https://other.example/objects/b1", "ann-1", "2026-01-02T00:00:00Z");

    const entries = await getHomeTimeline(db, ME, 20);
    expect(entries).toHaveLength(1);
    expect(entries[0].object.id).toBe("https://other.example/objects/b1");
    expect(entries[0].boost).toMatchObject({ id: "ann-1", actorId: ALICE });
  });

  it("hides a boost of a followers-only post when the viewer does not follow its author", async () => {
    await follow(ME, ALICE);
    await insertObject("https://other.example/objects/b2", BOB, "private", "2026-01-01T00:00:00Z");
    await boost(ALICE, "https://other.example/objects/b2", "ann-2", "2026-01-02T00:00:00Z");
    expect(await getHomeTimeline(db, ME, 20)).toHaveLength(0);

    // Following the original author makes the boost visible (the plain post
    // also enters through the follows branch).
    await follow(ME, BOB);
    const entries = await getHomeTimeline(db, ME, 20);
    expect(entries.some((entry) => entry.boost?.id === "ann-2")).toBe(true);
  });

  it("orders by the boost time, not the original post's published date", async () => {
    await follow(ME, ALICE);
    await insertObject("https://other.example/objects/old", BOB, "public", "2025-01-01T00:00:00Z");
    await insertObject("https://remote.example/objects/new", ALICE, "public", "2026-01-01T00:00:00Z");
    await boost(ALICE, "https://other.example/objects/old", "ann-3", "2026-02-01T00:00:00Z");

    const entries = await getHomeTimeline(db, ME, 20);
    expect(entries.map((entry) => entry.object.id)).toEqual([
      "https://other.example/objects/old",
      "https://remote.example/objects/new",
    ]);
  });

  it("paginates with a boost wrapper cursor", async () => {
    await follow(ME, ALICE);
    await insertObject("https://other.example/objects/a", BOB, "public", "2026-01-01T00:00:00Z");
    await insertObject("https://other.example/objects/b", BOB, "public", "2026-01-01T00:00:00Z");
    await boost(ALICE, "https://other.example/objects/a", "ann-a", "2026-02-02T00:00:00Z");
    await boost(ALICE, "https://other.example/objects/b", "ann-b", "2026-02-01T00:00:00Z");

    const first = await getHomeTimeline(db, ME, 1);
    expect(first[0].object.id).toBe("https://other.example/objects/a");

    // The route exposes the wrapper id as a local-style id and decodes it back
    // to https://{domain}/objects/{announceId}.
    const cursor = `https://local.example/objects/${first[0].boost!.id}`;
    const second = await getHomeTimeline(db, ME, 1, cursor);
    expect(second.map((entry) => entry.object.id)).toEqual(["https://other.example/objects/b"]);
  });

  it("hides boosts from blocked accounts and blocked domains", async () => {
    await follow(ME, ALICE);
    await insertObject("https://other.example/objects/c", BOB, "public", "2026-01-01T00:00:00Z");
    await boost(ALICE, "https://other.example/objects/c", "ann-c", "2026-01-02T00:00:00Z");

    await db.prepare("INSERT INTO blocks (id, actor_id, target_id) VALUES ('blk', ?, ?)").bind(ME, ALICE).run();
    expect(await getHomeTimeline(db, ME, 20)).toHaveLength(0);

    await db.prepare("DELETE FROM blocks").run();
    await db.prepare("INSERT INTO domain_blocks (id, actor_id, domain) VALUES ('db', ?, 'other.example')").bind(ME).run();
    expect(await getHomeTimeline(db, ME, 20)).toHaveLength(0);
  });

  it("keeps suspended boosters out of the home timeline", async () => {
    await follow(ME, ALICE);
    await insertObject("https://other.example/objects/d", BOB, "public", "2026-01-01T00:00:00Z");
    await boost(ALICE, "https://other.example/objects/d", "ann-d", "2026-01-02T00:00:00Z");
    await db.prepare("UPDATE actors SET suspended = 1 WHERE id = ?").bind(ALICE).run();
    expect(await getHomeTimeline(db, ME, 20)).toHaveLength(0);
  });
});

describe("profile boosts", () => {
  it("includes the account's boosts by default and excludes them on demand", async () => {
    await insertObject("https://other.example/objects/p", BOB, "public", "2026-01-01T00:00:00Z");
    await insertObject("https://remote.example/objects/alice", ALICE, "public", "2026-01-03T00:00:00Z");
    await boost(ALICE, "https://other.example/objects/p", "ann-p", "2026-01-04T00:00:00Z");

    const withBoosts = await getActorStatuses(db, ALICE, 20, undefined, ME, false, { includeBoosts: true });
    expect(withBoosts.map((entry) => entry.object.id)).toEqual([
      "https://other.example/objects/p",
      "https://remote.example/objects/alice",
    ]);
    expect(withBoosts[0].boost).toMatchObject({ id: "ann-p", actorId: ALICE });

    const withoutBoosts = await getActorStatuses(db, ALICE, 20, undefined, ME, false);
    expect(withoutBoosts.map((entry) => entry.object.id)).toEqual(["https://remote.example/objects/alice"]);
    expect(withoutBoosts[0].boost).toBeNull();
  });
});

