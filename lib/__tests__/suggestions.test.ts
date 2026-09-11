// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

import { getAccountSuggestions, dismissSuggestedAccount, undismissSuggestedAccount } from "@/lib/db";

class D1Adapter {
  private sql = new DatabaseSync(":memory:");

  constructor(schemaSql: string) {
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(schemaSql);
  }

  async batch(statements: { run(): Promise<D1Result> }[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const s of statements) results.push(await s.run());
    return results;
  }

  prepare(query: string) {
    const stmt = this.sql.prepare(query);
    return {
      bind(...params: unknown[]) {
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
        return {
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
            return { results: stmt.all(...(bound as never[])) as unknown as T[], success: true, meta: {} };
          },
          async first<T = unknown>(): Promise<T | null> {
            return (stmt.get(...(bound as never[])) as unknown as T | undefined) ?? null;
          },
          async run(): Promise<D1Result> {
            const info = stmt.run(...(bound as never[]));
            return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
          },
        };
      },
    };
  }
}

type ActorOpts = {
  isLocal?: boolean;
  discoverable?: boolean;
  suspended?: boolean;
  silenced?: boolean;
  reserved?: boolean;
  statuses?: number;
  followers?: number;
  lastStatusAt?: string | null;
};

function insertActor(db: D1Database, id: string, opts: ActorOpts = {}) {
  const username = id.split("/").pop()!.split("@")[0];
  const domain = id.split("/")[2].split(":")[0];
  return db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, suspended, silenced, reserved, statuses_count, followers_count, last_status_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      id,
      username,
      domain,
      "k",
      opts.isLocal ? "p" : null,
      opts.isLocal ? 1 : 0,
      opts.discoverable === false ? 0 : 1,
      opts.suspended ? 1 : 0,
      opts.silenced ? 1 : 0,
      opts.reserved ? 1 : 0,
      opts.statuses ?? 1,
      opts.followers ?? 0,
      opts.lastStatusAt ?? null
    )
    .run();
}

function insertFollow(db: D1Database, actorId: string, targetId: string, state = "accepted") {
  return db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?,?,?,?)")
    .bind(`${actorId}->${targetId}`, actorId, targetId, state)
    .run();
}

const ME = "https://local.example/users/me";

let db: D1Database;

beforeEach(async () => {
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;
  await insertActor(db, ME, { isLocal: true, lastStatusAt: "2025-01-01T00:00:00Z" });
});

describe("getAccountSuggestions", () => {
  it("anonymous viewers get active local accounts, newest first", async () => {
    await insertActor(db, "https://local.example/users/active-a", { isLocal: true, lastStatusAt: "2026-02-01T00:00:00Z", followers: 3 });
    await insertActor(db, "https://local.example/users/active-b", { isLocal: true, lastStatusAt: "2026-01-15T00:00:00Z", followers: 9 });
    await insertActor(db, "https://local.example/users/no-status", { isLocal: true, statuses: 0, lastStatusAt: null });
    await insertActor(db, "https://local.example/users/suspended", { isLocal: true, suspended: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/silenced", { isLocal: true, silenced: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/undiscoverable", { isLocal: true, discoverable: false, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://remote.example/users/remote", { isLocal: false, lastStatusAt: "2026-03-01T00:00:00Z" });

    const out = await getAccountSuggestions(db, null);
    expect(out.map((s) => s.actor.id)).toEqual([
      "https://local.example/users/active-a",
      "https://local.example/users/active-b",
      "https://local.example/users/me",
    ]);
    expect(out.every((s) => s.source === "global")).toBe(true);
  });

  it("ranks friends-of-friends first and excludes followed, blocked, muted and dismissed accounts", async () => {
    await insertActor(db, "https://local.example/users/followed", { isLocal: true });
    await insertActor(db, "https://local.example/users/fof1", { isLocal: true, lastStatusAt: "2026-01-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/fof2", { isLocal: true, lastStatusAt: "2026-01-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/popular", { isLocal: true, lastStatusAt: "2026-02-01T00:00:00Z", followers: 100 });
    await insertActor(db, "https://local.example/users/blocked", { isLocal: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/muted", { isLocal: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/dismissed", { isLocal: true, lastStatusAt: "2026-03-01T00:00:00Z" });

    await insertFollow(db, ME, "https://local.example/users/followed");
    // followed -> fof1 and fof2; another follower also -> fof1, so fof1 scores higher
    await insertFollow(db, "https://local.example/users/followed", "https://local.example/users/fof1");
    await insertFollow(db, "https://local.example/users/followed", "https://local.example/users/fof2");
    await insertActor(db, "https://local.example/users/other", { isLocal: true });
    await insertFollow(db, ME, "https://local.example/users/other");
    await insertFollow(db, "https://local.example/users/other", "https://local.example/users/fof1");
    await db.prepare("INSERT INTO blocks (id, actor_id, target_id) VALUES (?,?,?)").bind("b1", ME, "https://local.example/users/blocked").run();
    await db.prepare("INSERT INTO mutes (id, actor_id, target_id) VALUES (?,?,?)").bind("m1", ME, "https://local.example/users/muted").run();
    await dismissSuggestedAccount(db, ME, "https://local.example/users/dismissed");

    // Pending follows of mine must not count either.
    await insertActor(db, "https://local.example/users/pending", { isLocal: true });
    await insertFollow(db, ME, "https://local.example/users/pending", "pending");

    const ids = (await getAccountSuggestions(db, ME)).map((s) => s.actor.id);
    expect(ids).not.toContain("https://local.example/users/followed");
    expect(ids).not.toContain("https://local.example/users/blocked");
    expect(ids).not.toContain("https://local.example/users/muted");
    expect(ids).not.toContain("https://local.example/users/dismissed");
    expect(ids).not.toContain("https://local.example/users/pending");

    const fof1 = ids.indexOf("https://local.example/users/fof1");
    const fof2 = ids.indexOf("https://local.example/users/fof2");
    const popular = ids.indexOf("https://local.example/users/popular");
    expect(fof1).toBeGreaterThanOrEqual(0);
    expect(fof1).toBeLessThan(fof2);
    expect(fof2).toBeLessThan(popular);

    const byId = new Map((await getAccountSuggestions(db, ME)).map((s) => [s.actor.id, s.source]));
    expect(byId.get("https://local.example/users/fof1")).toBe("friends_of_friends");
    expect(byId.get("https://local.example/users/popular")).toBe("global");
  });

  it("supports limit/offset and keeps dismissals idempotent", async () => {
    await insertActor(db, "https://local.example/users/a", { isLocal: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/b", { isLocal: true, lastStatusAt: "2026-02-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/c", { isLocal: true, lastStatusAt: "2026-01-01T00:00:00Z" });

    const first = await getAccountSuggestions(db, null, { limit: 2 });
    expect(first.map((s) => s.actor.id)).toEqual([
      "https://local.example/users/a",
      "https://local.example/users/b",
    ]);
    const second = await getAccountSuggestions(db, null, { limit: 2, offset: 2 });
    expect(second.map((s) => s.actor.id)).toEqual([
      "https://local.example/users/c",
      "https://local.example/users/me",
    ]);

    await dismissSuggestedAccount(db, ME, "https://local.example/users/a");
    await dismissSuggestedAccount(db, ME, "https://local.example/users/a");
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM dismissed_suggestions WHERE actor_id = ?")
      .bind(ME)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const after = await getAccountSuggestions(db, ME);
    expect(after.map((s) => s.actor.id)).not.toContain("https://local.example/users/a");

    await undismissSuggestedAccount(db, ME, "https://local.example/users/a");
    const restored = await getAccountSuggestions(db, ME);
    expect(restored.map((s) => s.actor.id)).toContain("https://local.example/users/a");
  });
});
