// @vitest-environment node
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

import { loadSerializedPolls } from "@/lib/mastodon/serializers";

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

describe("loadSerializedPolls", () => {
  it("marks a poll as voted for the viewer who voted and leaves others untouched", async () => {
    const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
    const db = new D1Adapter(schema) as unknown as D1Database;
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://local.example/objects/1', 'Note', 'https://local.example/users/me', 'q', 'public', 1, '{}')`
    ).bind().run();
    await db.prepare(
      "INSERT INTO polls (id, object_id, expires_at, multiple, votes_count, voters_count) VALUES ('p1', 'https://local.example/objects/1', ?, 0, 1, 1)"
    ).bind(new Date(Date.now() + 60_000).toISOString()).run();
    await db.prepare("INSERT INTO poll_options (id, poll_id, title, votes_count, position) VALUES ('o1','p1','A',1,0)").bind().run();
    await db.prepare("INSERT INTO poll_options (id, poll_id, title, votes_count, position) VALUES ('o2','p1','B',0,1)").bind().run();
    await db.prepare(
      "INSERT INTO poll_votes (id, poll_id, actor_id, option_idx) VALUES ('v1','p1','https://local.example/users/me',0)"
    ).bind().run();

    const map = await loadSerializedPolls(db, "https://local.example/users/me", ["https://local.example/objects/1"]);
    const poll = map.get("https://local.example/objects/1");
    expect(poll?.voted).toBe(true);
    expect(poll?.own_votes).toEqual([0]);

    const anonymous = await loadSerializedPolls(db, null, ["https://local.example/objects/1"]);
    expect(anonymous.get("https://local.example/objects/1")?.voted).toBe(false);
    expect(anonymous.get("https://local.example/objects/1")?.own_votes).toEqual([]);
  });
});
