import { beforeAll, beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { GET as collectionsRoute } from "@/app/objects/[id]/[collection]/route";
import { GET as outboxRoute } from "@/app/api/users/[username]/outbox/route";

beforeAll(async () => {
  await applyTestSchema();
});

const db = env.DB;
const BASE = "https://local.example";
const ACTOR = `${BASE}/users/me`;
const ROOT = `${BASE}/objects/root`;

beforeEach(async () => {
  await resetTestStorage();
  await db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, statuses_count)
     VALUES (?, 'me', 'local.example', 'k', 'p', 1, 1, 3)`
  ).bind(ACTOR).run();
  await db.prepare(
    `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, published, favourites_count, reblogs_count)
     VALUES (?, 'Note', ?, 'root', 'public', 1, '{}', '2026-01-10T00:00:00Z', 7, 3)`
  ).bind(ROOT, ACTOR).run();
  for (const [id, day] of [["r1", "2026-01-11"], ["r2", "2026-01-12"]] as const) {
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, published, in_reply_to_id)
       VALUES (?, 'Note', ?, 'reply', 'public', 1, '{}', ?, ?)`
    ).bind(`${BASE}/objects/${id}`, ACTOR, `${day}T00:00:00Z`, ROOT).run();
  }
});

/** The handlers read `nextUrl.searchParams` and `url` (see account-follow-lists). */
function req(url: string): never {
  const parsed = new URL(url);
  return { nextUrl: parsed, url: parsed.toString() } as never;
}

function get(path: string, collection: string): Promise<Response> {
  return collectionsRoute(req(`${BASE}/objects/${path}/${collection}`), {
    params: Promise.resolve({ id: path, collection }),
  });
}

describe("status collections (Mastodon's likes/shares/replies)", () => {
  it("serves likes and shares as count-only collections", async () => {
    const likes = (await (await get("root", "likes")).json()) as Record<string, unknown>;
    expect(likes.type).toBe("Collection");
    expect(likes.id).toBe(`${ROOT}/likes`);
    expect(likes.totalItems).toBe(7);

    const shares = (await (await get("root", "shares")).json()) as Record<string, unknown>;
    expect(shares.id).toBe(`${ROOT}/shares`);
    expect(shares.totalItems).toBe(3);
  });

  it("serves the replies collection with the reply IRIs, oldest first", async () => {
    const body = (await (await get("root", "replies")).json()) as {
      id: string;
      type: string;
      first: { type: string; partOf: string; orderedItems: string[] };
    };
    expect(body.id).toBe(`${ROOT}/replies`);
    expect(body.type).toBe("Collection");
    expect(body.first.type).toBe("CollectionPage");
    expect(body.first.partOf).toBe(`${ROOT}/replies`);
    expect(body.first.orderedItems).toEqual([`${BASE}/objects/r1`, `${BASE}/objects/r2`]);
  });

  it("serves a single replies page when asked with page=true", async () => {
    const body = (await (await collectionsRoute(req(`${BASE}/objects/root/replies?page=true`), {
      params: Promise.resolve({ id: "root", collection: "replies" }),
    })).json()) as { type: string; orderedItems: string[]; partOf: string };
    expect(body.type).toBe("CollectionPage");
    expect(body.partOf).toBe(`${ROOT}/replies`);
    expect(body.orderedItems.length).toBe(2);
  });

  it("hides the collections of a non-public status", async () => {
    await db.prepare("UPDATE objects SET visibility = 'private' WHERE id = ?").bind(ROOT).run();
    expect((await get("root", "likes")).status).toBe(404);
    expect((await get("root", "replies")).status).toBe(404);
  });

  it("returns 404 for an unknown collection or object", async () => {
    expect((await get("root", "followers")).status).toBe(404);
    expect((await get("missing", "likes")).status).toBe(404);
  });
});

describe("outbox last page", () => {
  it("advertises the last link like Mastodon", async () => {
    const body = (await (await outboxRoute(req(`${ACTOR}/outbox`), {
      params: Promise.resolve({ username: "me" }),
    })).json()) as { first: string; last?: string };
    expect(body.first).toBe(`${ACTOR}/outbox?page=true`);
    expect(body.last).toBe(`${ACTOR}/outbox?page=true&min_id=0`);
  });

  it("resolves the last link to the oldest public statuses", async () => {
    const body = (await (await outboxRoute(req(`${ACTOR}/outbox?page=true&min_id=0`), {
      params: Promise.resolve({ username: "me" }),
    })).json()) as { type: string; orderedItems: Array<{ id: string }> };
    expect(body.type).toBe("OrderedCollectionPage");
    // Newest-first within the page, but this is the oldest page of the
    // collection (the outbox wraps each status in a Create activity).
    expect(body.orderedItems.map((item) => item.id)).toEqual([
      `${BASE}/activities/r2-create`,
      `${BASE}/activities/r1-create`,
      `${BASE}/activities/root-create`,
    ]);
  });
});
