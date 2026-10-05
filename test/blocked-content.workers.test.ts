import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

import {
  getBlockedActorIds,
  getBlockedDomains,
  getHashtagTimeline,
  getHomeTimeline,
  getListTimeline,
} from "@/lib/db";

const ME = "https://local.example/users/me";
const FOLLOWED = "https://remote.example/users/followed";
const BLOCKED = "https://blocked.example/users/spammer";
const OTHER = "https://other.example/users/friend";

const db = env.DB;

async function insertActor(db: D1Database, id: string): Promise<void> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      "INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, ?, ?, 'pem', 0)"
    )
    .bind(id, username, new URL(id).hostname)
    .run();
}

async function insertObject(
  db: D1Database,
  id: string,
  actorId: string,
  opts: { replyTo?: string; visibility?: string; tags?: string[] } = {}
): Promise<void> {
  const published = new Date(Date.now() - Math.random() * 60_000).toISOString();
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, in_reply_to_id, published, updated_at, url)
       VALUES (?, 'Note', ?, '<p>hi</p>', ?, ?, ?, ?, ?)`
    )
    .bind(id, actorId, opts.visibility ?? "public", opts.replyTo ?? null, published, published, id)
    .run();
  for (const tag of opts.tags ?? []) {
    await db
      .prepare("INSERT INTO object_tags (object_id, tag, published, actor_id) VALUES (?, ?, ?, ?)")
      .bind(id, tag, published, actorId)
      .run();
  }
}

async function ids(db: D1Database, objects: { id: string }[]): Promise<string[]> {
  return objects.map((o) => o.id);
}

describe("blocked accounts in timelines and threads", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    for (const id of [ME, FOLLOWED, BLOCKED, OTHER]) await insertActor(db, id);
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
      .bind(ME, FOLLOWED)
      .run();
  });

  it("hides replies addressed to a blocked account from the home timeline", async () => {
    await insertObject(db, "https://blocked.example/objects/parent", BLOCKED);
    await insertObject(db, "https://remote.example/objects/reply-to-blocked", FOLLOWED, {
      replyTo: "https://blocked.example/objects/parent",
    });
    await insertObject(db, "https://remote.example/objects/normal", FOLLOWED);
    await insertObject(db, "https://other.example/objects/parent", OTHER);
    await insertObject(db, "https://remote.example/objects/reply-to-other", FOLLOWED, {
      replyTo: "https://other.example/objects/parent",
    });

    await db
      .prepare("INSERT INTO blocks (id, actor_id, target_id) VALUES ('b1', ?, ?)")
      .bind(ME, BLOCKED)
      .run();

    const timeline = await ids(db, await getHomeTimeline(db, ME, 20));
    expect(timeline).not.toContain("https://remote.example/objects/reply-to-blocked");
    // Replies to accounts that are not blocked stay.
    expect(timeline).toContain("https://remote.example/objects/reply-to-other");
    expect(timeline).toContain("https://remote.example/objects/normal");
  });

  it("hides replies to an account from a blocked domain", async () => {
    await insertObject(db, "https://blocked.example/objects/parent2", BLOCKED);
    await insertObject(db, "https://remote.example/objects/reply2", FOLLOWED, {
      replyTo: "https://blocked.example/objects/parent2",
    });
    await db
      .prepare("INSERT INTO domain_blocks (id, actor_id, domain) VALUES ('d1', ?, 'blocked.example')")
      .bind(ME)
      .run();

    const timeline = await ids(db, await getHomeTimeline(db, ME, 20));
    expect(timeline).not.toContain("https://remote.example/objects/reply2");
  });

  it("applies the same rule to list and hashtag timelines", async () => {
    await insertObject(db, "https://blocked.example/objects/parent3", BLOCKED);
    await insertObject(db, "https://remote.example/objects/reply3", FOLLOWED, {
      replyTo: "https://blocked.example/objects/parent3",
      tags: ["prueba"],
    });
    await insertObject(db, "https://remote.example/objects/tagged", FOLLOWED, { tags: ["prueba"] });
    await db
      .prepare("INSERT INTO lists (id, actor_id, title) VALUES ('l1', ?, 'Lista')")
      .bind(ME)
      .run();
    await db
      .prepare("INSERT INTO list_accounts (id, list_id, actor_id) VALUES ('la1', 'l1', ?)")
      .bind(FOLLOWED)
      .run();
    await db
      .prepare("INSERT INTO blocks (id, actor_id, target_id) VALUES ('b2', ?, ?)")
      .bind(ME, BLOCKED)
      .run();

    const list = await ids(db, await getListTimeline(db, "l1", ME, 20));
    expect(list).not.toContain("https://remote.example/objects/reply3");
    expect(list).toContain("https://remote.example/objects/tagged");

    const tag = await ids(db, await getHashtagTimeline(db, "prueba", 20, undefined, undefined, ME));
    expect(tag).not.toContain("https://remote.example/objects/reply3");
    expect(tag).toContain("https://remote.example/objects/tagged");
  });

  it("exposes the viewer's blocked accounts and domains", async () => {
    await db
      .prepare("INSERT INTO blocks (id, actor_id, target_id) VALUES ('b3', ?, ?)")
      .bind(ME, BLOCKED)
      .run();
    await db
      .prepare("INSERT INTO domain_blocks (id, actor_id, domain) VALUES ('d2', ?, 'spam.example')")
      .bind(ME)
      .run();

    expect(await getBlockedActorIds(db, ME)).toEqual([BLOCKED]);
    expect(await getBlockedDomains(db, ME)).toEqual(["spam.example"]);
  });
});
