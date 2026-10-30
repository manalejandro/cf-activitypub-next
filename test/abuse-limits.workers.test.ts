import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { POST as FAVOURITE } from "@/app/api/v1/statuses/[id]/favourite/route";
import { POST as REBLOG } from "@/app/api/v1/statuses/[id]/reblog/route";
import { PUT as EDIT_STATUS } from "@/app/api/v1/statuses/[id]/route";
import { POST as LIST_ACCOUNTS_ADD, DELETE as LIST_ACCOUNTS_REMOVE } from "@/app/api/v1/lists/[id]/accounts/route";
import { GET as SEARCH } from "@/app/api/v2/search/route";
import { resolveLimits } from "@/lib/constants";

const db = env.DB;
const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;
const BOB = `${BASE}/users/bob`;
const BOB_OBJ = `${BASE}/objects/bob-1`;
const ALICE_OBJ = `${BASE}/objects/alice-1`;
const TOKEN = "abuse-token";

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

async function seedObject(id: string, actorId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, raw, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, '<p>hi</p>', '{}', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
    )
    .bind(id, actorId)
    .run();
}

/** Current fixed-window bucket of lib/cf's checkRateLimit (the KV fallback). */
function windowKey(key: string): string {
  return `ratelimit:${key}:${Math.floor(Date.now() / 1000 / 60)}`;
}

/**
 * Exhaust the limiter of `key` on BOTH backends: the atomic Durable Object
 * (the routes call `atomicRateLimit`, which prefers it whenever the
 * RATE_LIMIT binding exists — the KV seed alone no longer reaches them) and
 * the KV fixed-window counter (instances without the binding). After `count`
 * hits the route's own call is the one over budget.
 */
async function exhaust(key: string, count: number): Promise<void> {
  await env.KV.put(windowKey(key), String(count), { expirationTtl: 120 });
  const ns = (env as unknown as { RATE_LIMIT?: DurableObjectNamespace }).RATE_LIMIT;
  if (!ns) return;
  const stub = ns.get(ns.idFromName(key));
  for (let i = 0; i < count; i++) {
    const res = await stub.fetch("https://rate-limit/hit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max: count, windowSeconds: 60 }),
    });
    await res.body?.cancel();
  }
}

/**
 * Assert the route answers 429 once the budget of `key` is spent. Retries
 * once: a fixed window can roll between the exhaustion and the call (the
 * second exhaustion then lands in the fresh window for sure — two boundaries
 * cannot pass inside a second).
 */
async function expectLimited(key: string, budget: number, call: () => Promise<Response>): Promise<void> {
  let last = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await exhaust(key, budget);
    last = (await call()).status;
    if (last === 429) return;
  }
  expect(last).toBe(429);
}

function authed(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null } = {}
): NextRequest {
  return new NextRequest(url, {
    method: init.method,
    body: init.body,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await resetTestStorage();
  // The atomic limiter lives in a Durable Object whose storage SURVIVES
  // resetTestStorage: clear the windows this file uses, or an exhausted
  // budget leaks into the next test (an oversized edit answered 429 before
  // its validation ran).
  const ns = (env as unknown as { RATE_LIMIT?: DurableObjectNamespace }).RATE_LIMIT;
  if (ns) {
    for (const key of [`favourite:${ALICE}`, `reblog:${ALICE}`, `edit:${ALICE}`, `search-resolve:${ALICE}`]) {
      const stub = ns.get(ns.idFromName(key));
      const res = await stub.fetch("https://rate-limit/reset", { method: "POST" });
      await res.body?.cancel();
    }
  }
  await seedActor(ALICE);
  await seedActor(BOB);
  await seedObject(BOB_OBJ, BOB);
  await seedObject(ALICE_OBJ, ALICE);
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(ALICE, TOKEN)
    .run();
});

describe("interaction rate limits", () => {
  it("429s a favourite once the per-account budget is spent", async () => {
    await expectLimited(`favourite:${ALICE}`, 60, () =>
      FAVOURITE(
        authed(`${BASE}/api/v1/statuses/x/favourite`, { method: "POST" }),
        params(BOB_OBJ)
      )
    );
  });

  it("429s a reblog once the per-account budget is spent", async () => {
    await expectLimited(`reblog:${ALICE}`, 30, () =>
      REBLOG(
        authed(`${BASE}/api/v1/statuses/x/reblog`, { method: "POST" }),
        params(BOB_OBJ)
      )
    );
  });

  it("429s an edit once the per-account budget is spent", async () => {
    await expectLimited(`edit:${ALICE}`, 20, () =>
      EDIT_STATUS(
        authed(`${BASE}/api/v1/statuses/x`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "hello" }),
        }),
        params(ALICE_OBJ)
      )
    );
  });

  it("429s a resolving search once the per-account budget is spent", async () => {
    await expectLimited(`search-resolve:${ALICE}`, 15, () =>
      SEARCH(
        authed(`${BASE}/api/v2/search?q=${encodeURIComponent("https://remote.example/users/x")}&resolve=true`)
      )
    );
  });
});

describe("edit validation", () => {
  it("rejects an oversized edit with the same limit as the create route", async () => {
    const limits = resolveLimits(env as unknown as Record<string, unknown>);
    const res = await EDIT_STATUS(
      authed(`${BASE}/api/v1/statuses/x`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "a".repeat(limits.maxStatusChars + 1) }),
      }),
      params(ALICE_OBJ)
    );
    expect(res.status).toBe(422);
  });
});

describe("list membership over the D1 bind limit", () => {
  const LIST_ID = "list-1";
  const N = 150; // > D1's ~100-parameter bind limit

  async function seedListAndMembers(): Promise<string[]> {
    await db
      .prepare("INSERT INTO lists (id, actor_id, title) VALUES (?, ?, 'test')")
      .bind(LIST_ID, ALICE)
      .run();
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = `${BASE}/users/m${i}`;
      await seedActor(id);
      ids.push(id);
    }
    return ids;
  }

  it("adds and removes more than 100 accounts in one request", async () => {
    const ids = await seedListAndMembers();

    const addRes = await LIST_ACCOUNTS_ADD(
      authed(`${BASE}/api/v1/lists/${LIST_ID}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_ids: ids }),
      }),
      params(LIST_ID)
    );
    expect(addRes.status).toBe(200);
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM list_accounts WHERE list_id = ?")
      .bind(LIST_ID)
      .first<{ n: number }>();
    expect(Number(count?.n)).toBe(N);

    const query = ids.map((id) => `account_ids[]=${encodeURIComponent(id)}`).join("&");
    const delRes = await LIST_ACCOUNTS_REMOVE(
      authed(`${BASE}/api/v1/lists/${LIST_ID}/accounts?${query}`, { method: "DELETE" }),
      params(LIST_ID)
    );
    expect(delRes.status).toBe(200);
    const after = await db
      .prepare("SELECT COUNT(*) AS n FROM list_accounts WHERE list_id = ?")
      .bind(LIST_ID)
      .first<{ n: number }>();
    expect(Number(after?.n)).toBe(0);
  });
});
