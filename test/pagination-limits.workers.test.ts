import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { resolveLimits } from "@/lib/constants";
import { GET as PUBLIC_TIMELINE } from "@/app/api/v1/timelines/public/route";
import { GET as FOLLOWERS } from "@/app/api/v1/accounts/[id]/followers/route";
import { GET as FOLLOWING } from "@/app/api/v1/accounts/[id]/following/route";
import { GET as TRENDS_TAGS } from "@/app/api/v1/trends/tags/route";
import { GET as TAGS_SEARCH } from "@/app/api/v1/tags/search/route";

const db = env.DB;
// The effective limits (env vars may override the defaults): the assertions
// below must follow them instead of hardcoding 20/40.
const limits = resolveLimits(env as unknown as Record<string, unknown>);
const SEED_COUNT = limits.maxPageSize + 5;
const BASE = "https://local.example.test";
const AUTHOR = `${BASE}/users/author`;
const TARGET = `${BASE}/users/target`;

// SQLite reads a negative LIMIT as "no limit": before clampLimit, an anonymous
// ?limit=-1 dumped every row of the table into the Worker (OOM on a large
// instance). These tests pin the clamped behaviour on the public surfaces.

async function seedActor(id: string): Promise<void> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, email, email_verified)
       VALUES (?, ?, ?, 'pub', 'priv', 1, 1, 'user', ?, 1)`
    )
    .bind(id, username, new URL(id).hostname, `${username}@example.com`)
    .run();
}

async function seedStatuses(count: number): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const iso = new Date(now - i * 60_000).toISOString();
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
         VALUES (?, 'Note', ?, '<p>hello</p>', 'public', ?, ?, 1)`
      )
      .bind(`${BASE}/objects/s${i}`, AUTHOR, iso, iso)
      .run();
  }
}

async function seedFollows(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const followerId = `${BASE}/users/f${i}`;
    await seedActor(followerId);
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?, ?, ?, 'accepted')")
      .bind(`fl${i}`, followerId, TARGET)
      .run();
  }
}

async function seedFollowing(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const targetId = `${BASE}/users/g${i}`;
    await seedActor(targetId);
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?, ?, ?, 'accepted')")
      .bind(`fg${i}`, TARGET, targetId)
      .run();
  }
}

async function seedTag(tag: string, objectIds: string[]): Promise<void> {
  const iso = new Date().toISOString();
  for (const objectId of objectIds) {
    await db
      .prepare("INSERT INTO object_tags (object_id, tag, published, actor_id) VALUES (?, ?, ?, ?)")
      .bind(objectId, tag, iso, AUTHOR)
      .run();
  }
}

type RouteHandler = (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

function get(handler: unknown, path: string, ctx?: { params: Promise<Record<string, string>> }): Promise<Response> {
  return (handler as RouteHandler)(new NextRequest(`${BASE}${path}`), ctx);
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(AUTHOR);
  await seedActor(TARGET);
});

describe("public timeline pagination clamping", () => {
  it("turns ?limit=-1 into a single item instead of an unbounded dump", async () => {
    await seedStatuses(SEED_COUNT);
    const res = await get(PUBLIC_TIMELINE, "/api/v1/timelines/public?limit=-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(1);
  });

  it("caps an oversized limit at the page maximum", async () => {
    await seedStatuses(SEED_COUNT);
    const res = await get(PUBLIC_TIMELINE, "/api/v1/timelines/public?limit=999999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(limits.maxPageSize);
  });

  it("falls back to the default page size on a non-numeric limit", async () => {
    await seedStatuses(SEED_COUNT);
    const res = await get(PUBLIC_TIMELINE, "/api/v1/timelines/public?limit=abc");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(Math.min(limits.defaultTimelinePage, limits.maxPageSize));
  });
});

describe("follow list pagination clamping", () => {
  it("clamps ?limit=-1 and a negative page", async () => {
    await seedFollows(3);
    const res = await get(FOLLOWERS, "/api/v1/accounts/target/followers?limit=-1&page=-2", {
      params: Promise.resolve({ id: encodeURIComponent(TARGET) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(1);
  });

  it("clamps the following list the same way", async () => {
    await seedFollowing(3);
    const res = await get(FOLLOWING, "/api/v1/accounts/target/following?limit=-1", {
      params: Promise.resolve({ id: encodeURIComponent(TARGET) }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(1);
  });
});

describe("tag surface pagination clamping", () => {
  it("clamps the trending tags limit", async () => {
    await seedStatuses(2);
    await seedTag("alpha", [`${BASE}/objects/s0`]);
    await seedTag("beta", [`${BASE}/objects/s1`]);
    const res = await get(TRENDS_TAGS, "/api/v1/trends/tags?limit=-1");
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(1);
  });

  it("clamps the tag autocomplete limit", async () => {
    await seedStatuses(2);
    await seedTag("alpha", [`${BASE}/objects/s0`]);
    await seedTag("alphabet", [`${BASE}/objects/s1`]);
    const res = await get(TAGS_SEARCH, "/api/v1/tags/search?q=alp&limit=-1");
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(1);
  });
});
