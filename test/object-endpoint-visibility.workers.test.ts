import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";
import { GET as OBJECT_ENDPOINT } from "@/app/objects/[id]/route";

const db = env.DB;
const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;
const BOB = `${BASE}/users/bob`;
const CAROL = `${BASE}/users/carol`;

beforeAll(async () => {
  await applyTestSchema();
});

async function seedActor(id: string): Promise<void> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, ?, 1)`
    )
    .bind(id, username, `${username}@example.com`)
    .run();
}

async function seedToken(actorId: string, token: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(`tok-${token}`, actorId, token)
    .run();
}

async function seedObject(
  id: string,
  visibility: string,
  opts: { raw?: string } = {}
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, raw, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, '<p>secret</p>', ?, ?, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
    )
    .bind(id, ALICE, opts.raw ?? "{}", visibility)
    .run();
}

function fetchObject(id: string, token?: string): Promise<Response> {
  return OBJECT_ENDPOINT(
    new NextRequest(`${BASE}/objects/${id}`, {
      headers: {
        Accept: "application/activity+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(async () => {
  await resetTestDatabase();
  await seedActor(ALICE);
  await seedActor(BOB);
  await seedActor(CAROL);
  await seedToken(BOB, "bob-token");
  await seedToken(CAROL, "carol-token");
});

describe("GET /objects/:id visibility", () => {
  it("serves a public note to anyone and caches it", async () => {
    await seedObject(`${BASE}/objects/pub1`, "public");
    const res = await fetchObject("pub1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(`${BASE}/objects/pub1`);
    expect(await env.KV.get("ap:obj:pub1")).not.toBeNull();
  });

  it("404s a direct message for an anonymous fetch", async () => {
    await seedObject(`${BASE}/objects/dm1`, "direct");
    const res = await fetchObject("dm1");
    expect(res.status).toBe(404);
  });

  it("404s a followers-only note for an anonymous fetch", async () => {
    await seedObject(`${BASE}/objects/priv1`, "private");
    const res = await fetchObject("priv1");
    expect(res.status).toBe(404);
  });

  it("404s a direct message for an authenticated account outside the audience", async () => {
    await seedObject(`${BASE}/objects/dm1`, "direct");
    const res = await fetchObject("dm1", "carol-token");
    expect(res.status).toBe(404);
  });

  it("serves a direct message to the mentioned account and never caches it", async () => {
    await seedObject(`${BASE}/objects/dm1`, "direct", {
      raw: JSON.stringify({ tag: [{ type: "Mention", href: BOB, name: "@bob" }] }),
    });
    const res = await fetchObject("dm1", "bob-token");
    expect(res.status).toBe(200);
    expect(await env.KV.get("ap:obj:dm1")).toBeNull();
  });

  it("serves a followers-only note to an accepted follower", async () => {
    await seedObject(`${BASE}/objects/priv1`, "private");
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
      .bind(BOB, ALICE)
      .run();
    const res = await fetchObject("priv1", "bob-token");
    expect(res.status).toBe(200);
  });

  it("404s a followers-only note for an authenticated non-follower", async () => {
    await seedObject(`${BASE}/objects/priv1`, "private");
    const res = await fetchObject("priv1", "carol-token");
    expect(res.status).toBe(404);
  });
});
