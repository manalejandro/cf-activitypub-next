import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { GET as ACCOUNT_SEARCH } from "@/app/api/v1/accounts/search/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "search-token";

async function seedActor(id: string, opts: { local?: boolean; suspended?: boolean } = {}): Promise<string> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, suspended, email_verified)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, 1)`
    )
    .bind(id, username, domain, opts.local ? "priv" : null, opts.local ? 1 : 0, opts.suspended ? 1 : 0)
    .run();
  return id;
}

async function seedToken(actorId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(actorId, TOKEN)
    .run();
}

async function search(query: string, opts: { token?: string } = {}): Promise<{ status: number; body: { acct: string }[] }> {
  const res = await ACCOUNT_SEARCH(
    new NextRequest(`${BASE}/api/v1/accounts/search?q=${encodeURIComponent(query)}&limit=20&resolve=true`, {
      headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    })
  );
  return { status: res.status, body: (await res.json()) as { acct: string }[] };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
});

describe("GET /api/v1/accounts/search", () => {
  it("finds a local account by plain username, by handle and by profile URL", async () => {
    await seedActor(`${BASE}/users/manalejandro`, { local: true });

    expect((await search("manalejandro")).body.map((a) => a.acct)).toEqual(["manalejandro"]);
    // The reported bug: the leading @ must be stripped (Mastodon does it).
    expect((await search("@manalejandro@local.example.test")).body.map((a) => a.acct)).toEqual(["manalejandro"]);
    expect((await search("manalejandro@local.example.test")).body.map((a) => a.acct)).toEqual(["manalejandro"]);
    // …and a pasted profile URL must name the account (both shapes).
    expect((await search(`${BASE}/users/manalejandro`)).body.map((a) => a.acct)).toEqual(["manalejandro"]);
    expect((await search(`${BASE}/@manalejandro`)).body.map((a) => a.acct)).toEqual(["manalejandro"]);
  });

  it("never returns a suspended account", async () => {
    await seedActor(`${BASE}/users/bad`, { local: true, suspended: true });
    expect((await search("bad")).body).toEqual([]);
  });

  it("hides cached remote accounts from anonymous callers but shows them to the authenticated ones", async () => {
    const me = await seedActor(`${BASE}/users/me`, { local: true });
    await seedActor("https://remote.example/users/alice");

    expect((await search("alice@remote.example")).body).toEqual([]);

    await seedToken(me);
    const authed = await search("alice@remote.example", { token: TOKEN });
    expect(authed.status).toBe(200);
    expect(authed.body.map((a) => a.acct)).toEqual(["alice@remote.example"]);
  });

  it("returns an empty list for a blank query", async () => {
    expect((await search("   ")).body).toEqual([]);
  });
});
