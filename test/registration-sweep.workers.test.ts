import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

import { sweepAbusiveRegistrations } from "@/lib/moderation/registration-sweep";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

async function seedActor(
  db: D1Database,
  opts: {
    username: string;
    email: string | null;
    verified?: boolean;
    suspended?: boolean;
    canonicalHash?: string | null;
    createdAt?: string;
    posts?: number;
    followers?: number;
  }
): Promise<string> {
  const id = `https://cf-ap.com/users/${opts.username}`;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, is_local, email, email_verified,
                           suspended, canonical_email_hash, created_at, statuses_count, followers_count, following_count)
       VALUES (?, ?, 'cf-ap.com', 'pem', 1, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(
      id,
      opts.username,
      opts.email,
      opts.verified ? 1 : 0,
      opts.suspended ? 1 : 0,
      opts.canonicalHash ?? null,
      opts.createdAt ?? daysAgo(1),
      opts.posts ?? 0,
      opts.followers ?? 0
    )
    .run();
  return id;
}

async function seedToken(db: D1Database, actorId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at)
       VALUES (?, ?, NULL, ?, 'read', datetime('now'))`
    )
    .bind(`tok-${actorId}`, actorId, `token-${actorId}`)
    .run();
}

async function suspendedUsernames(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare("SELECT username FROM actors WHERE suspended = 1 ORDER BY username")
    .bind()
    .all<{ username: string }>();
  return rows.results.map((r) => r.username);
}

async function usernames(db: D1Database): Promise<string[]> {
  const rows = await db.prepare("SELECT username FROM actors ORDER BY username").bind().all<{ username: string }>();
  return rows.results.map((r) => r.username);
}

const db = env.DB;

describe("registration sweep", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  /** Run the sweep against the in-memory DB (no KV/EMAIL bindings). */
  function sweep(extra: Record<string, unknown> = {}) {
    return sweepAbusiveRegistrations({ DB: db, ...extra } as never);
  }

  it("suspends a mailbox farm (3+ accounts from one canonical mailbox)", async () => {
    const hash = "farm-hash";
    await seedActor(db, { username: "farm1", email: "a+1@relay.example", canonicalHash: hash, verified: false });
    await seedActor(db, { username: "farm2", email: "a+2@relay.example", canonicalHash: hash, verified: true });
    await seedActor(db, { username: "farm3", email: "a+3@relay.example", canonicalHash: hash, verified: false });

    const result = await sweep();

    expect(result.suspended).toBe(3);
    expect(await suspendedUsernames(db)).toEqual(["farm1", "farm2", "farm3"]);
    // The audit trail records each suspension.
    const logs = await db
      .prepare("SELECT COUNT(*) AS n FROM moderation_log WHERE action = 'suspended'")
      .bind()
      .first<{ n: number }>();
    expect(logs?.n).toBe(3);
  });

  it("does not touch two accounts sharing a mailbox (not a farm)", async () => {
    const hash = "pair-hash";
    await seedActor(db, { username: "pair1", email: "b+1@relay.example", canonicalHash: hash });
    await seedActor(db, { username: "pair2", email: "b+2@relay.example", canonicalHash: hash });

    const result = await sweep();

    expect(result.suspended).toBe(0);
    expect(await suspendedUsernames(db)).toEqual([]);
  });

  it("suspends accounts on disposable mail domains", async () => {
    await seedActor(db, { username: "temp1", email: "bot@tempmail.ai" });
    await seedActor(db, { username: "temp2", email: "bot@sub.ittiv.com" });
    await seedActor(db, { username: "normal", email: "user@protonmail.com" });

    const result = await sweep();

    expect(result.suspended).toBe(2);
    expect(await suspendedUsernames(db)).toEqual(["temp1", "temp2"]);
  });

  it("leaves a confirmed account on a throwaway-looking domain with activity", async () => {
    await seedActor(db, { username: "real", email: "real@tempmail.ai", verified: true, posts: 2, followers: 1 });

    const result = await sweep();

    expect(result.suspended).toBe(0);
    expect(await suspendedUsernames(db)).toEqual([]);
  });

  it("deletes silent accounts that never confirmed, and their tokens", async () => {
    const stale = await seedActor(db, { username: "never", email: "never@example.com", createdAt: daysAgo(30) });
    await seedToken(db, stale);
    await seedActor(db, { username: "fresh", email: "fresh@example.com", createdAt: daysAgo(1) });
    await seedActor(db, { username: "active", email: "active@example.com", createdAt: daysAgo(30), posts: 1 });
    await seedActor(db, { username: "confirmed", email: "ok@example.com", createdAt: daysAgo(30), verified: true });

    const result = await sweep();

    expect(result.deleted).toBe(1);
    expect(await usernames(db)).toEqual(["active", "confirmed", "fresh"]);
    const tokens = await db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").bind().first<{ n: number }>();
    expect(tokens?.n).toBe(0);
  });

  it("is idempotent and skips already-suspended accounts", async () => {
    await seedActor(db, { username: "bot1", email: "bot@tempmail.ai" });

    const first = await sweep();
    const second = await sweep();

    expect(first.suspended).toBe(1);
    expect(second.suspended).toBe(0);
    expect(await suspendedUsernames(db)).toEqual(["bot1"]);
  });

  it("honours UNVERIFIED_ACCOUNT_PURGE_DAYS=0 (no deletions)", async () => {
    await seedActor(db, { username: "never", email: "never@example.com", createdAt: daysAgo(60) });

    const result = await sweep({ UNVERIFIED_ACCOUNT_PURGE_DAYS: "0" });

    expect(result.deleted).toBe(0);
    expect(await usernames(db)).toEqual(["never"]);
  });
});
