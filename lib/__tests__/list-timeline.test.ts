// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

import { getListTimeline } from "@/lib/db";

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

const ME = "https://local.example/users/me";
const A = "https://local.example/users/a";
const B = "https://remote.example/users/b";
const C = "https://blocked.example/users/c";
const D = "https://remote.example/users/d";
const E = "https://other.example/users/e";
const LIST = "list-1";

let db: D1Database;

async function insertActor(id: string, domain: string) {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, ?, ?, 'k', NULL, 0)`
    )
    .bind(id, id.split("/").pop(), domain)
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

beforeEach(async () => {
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;

  await insertActor(ME, "local.example");
  await insertActor(A, "local.example");
  await insertActor(B, "remote.example");
  await insertActor(C, "blocked.example");
  await insertActor(D, "remote.example");
  await insertActor(E, "other.example");

  await db.prepare("INSERT INTO lists (id, actor_id, title) VALUES (?, ?, 'Test')").bind(LIST, ME).run();
  for (const member of [A, B, C, D]) {
    await db
      .prepare("INSERT INTO list_accounts (id, list_id, actor_id) VALUES (?, ?, ?)")
      .bind(`la-${member}`, LIST, member)
      .run();
  }

  await db.prepare("INSERT INTO blocks (id, actor_id, target_id) VALUES ('b1', ?, ?)").bind(ME, D).run();
  await db
    .prepare("INSERT INTO domain_blocks (id, actor_id, domain) VALUES ('db1', ?, 'blocked.example')")
    .bind(ME)
    .run();

  await insertObject("https://local.example/objects/a1", A, "public", "2026-01-05T00:00:00Z");
  await insertObject("https://local.example/objects/a2", A, "unlisted", "2026-01-06T00:00:00Z");
  await insertObject("https://remote.example/objects/b1", B, "public", "2026-01-04T00:00:00Z");
  await insertObject("https://remote.example/objects/b2", B, "private", "2026-01-07T00:00:00Z");
  await insertObject("https://blocked.example/objects/c1", C, "public", "2026-01-08T00:00:00Z");
  await insertObject("https://remote.example/objects/d1", D, "public", "2026-01-09T00:00:00Z");
  await insertObject("https://other.example/objects/e1", E, "public", "2026-01-10T00:00:00Z");
});

describe("getListTimeline", () => {
  it("merges public and unlisted member statuses newest-first, excluding blocked actors and domains", async () => {
    const rows = await getListTimeline(db, LIST, ME);
    expect(rows.map((r) => r.id)).toEqual([
      "https://local.example/objects/a2",
      "https://local.example/objects/a1",
      "https://remote.example/objects/b1",
    ]);
  });

  it("respects the limit", async () => {
    const rows = await getListTimeline(db, LIST, ME, 2);
    expect(rows.map((r) => r.id)).toEqual([
      "https://local.example/objects/a2",
      "https://local.example/objects/a1",
    ]);
  });

  it("paginates with max_id and since_id cursors", async () => {
    const older = await getListTimeline(db, LIST, ME, 20, "https://local.example/objects/a1");
    expect(older.map((r) => r.id)).toEqual(["https://remote.example/objects/b1"]);

    const newer = await getListTimeline(db, LIST, ME, 20, undefined, "https://remote.example/objects/b1");
    expect(newer.map((r) => r.id)).toEqual([
      "https://local.example/objects/a2",
      "https://local.example/objects/a1",
    ]);
  });

  it("returns nothing for an unknown cursor or an empty list", async () => {
    expect(await getListTimeline(db, LIST, ME, 20, "https://nope.example/objects/x")).toEqual([]);
    expect(await getListTimeline(db, "missing-list", ME)).toEqual([]);
  });

  it("unblocking a member restores their statuses", async () => {
    await db.prepare("DELETE FROM blocks WHERE actor_id = ? AND target_id = ?").bind(ME, D).run();
    await db.prepare("DELETE FROM domain_blocks WHERE actor_id = ? AND domain = 'blocked.example'").bind(ME).run();
    const rows = await getListTimeline(db, LIST, ME);
    expect(rows.map((r) => r.id)).toEqual([
      "https://remote.example/objects/d1",
      "https://blocked.example/objects/c1",
      "https://local.example/objects/a2",
      "https://local.example/objects/a1",
      "https://remote.example/objects/b1",
    ]);
  });
});
