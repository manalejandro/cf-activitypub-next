// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { deleteObject, deleteRemoteActorData } from "@/lib/db";

/** Minimal D1 adapter backed by node:sqlite (schema loaded from schema.sql). */
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

const OWNER = "https://local.example/users/me";
const REMOTE = "https://remote.example/users/alice";
const CONVERSATION = `dm:${OWNER}::${REMOTE}`;
const MSG_OLDER = "https://remote.example/users/alice/statuses/1";
const MSG_NEWER = "https://remote.example/users/alice/statuses/2";

function directRaw(): string {
  return JSON.stringify({
    to: [OWNER, REMOTE],
    cc: [],
    tag: [
      { type: "Mention", href: OWNER },
      { type: "Mention", href: REMOTE },
    ],
  });
}

let db: D1Database;

beforeEach(async () => {
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,1)")
    .bind(OWNER, "me", "local.example", "k")
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,0)")
    .bind(REMOTE, "alice", "remote.example", "k")
    .run();
  for (const [id, published] of [[MSG_OLDER, "2026-09-20T10:00:00.000Z"], [MSG_NEWER, "2026-09-21T10:00:00.000Z"]] as const) {
    await db
      .prepare("INSERT INTO objects (id, type, actor_id, visibility, published, updated_at, raw) VALUES (?,?,?,?,?,?,?)")
      .bind(id, "Note", REMOTE, "direct", published, published, directRaw())
      .run();
  }
  await db
    .prepare("INSERT INTO conversations (id, actor_id, last_status_id, unread) VALUES (?,?,?,0)")
    .bind(CONVERSATION, OWNER, MSG_NEWER)
    .run();
});

describe("private-message conversations", () => {
  it("falls back to the previous message when the latest one is deleted", async () => {
    await deleteObject(db, MSG_NEWER);
    const conv = await db
      .prepare("SELECT last_status_id FROM conversations WHERE id = ?")
      .bind(CONVERSATION)
      .first<{ last_status_id: string | null }>();
    expect(conv?.last_status_id).toBe(MSG_OLDER);
  });

  it("drops the conversation when the thread has no messages left", async () => {
    await deleteObject(db, MSG_NEWER);
    await deleteObject(db, MSG_OLDER);
    const conv = await db
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .bind(CONVERSATION)
      .first<{ id: string }>();
    expect(conv).toBeNull();
  });

  it("drops the conversation when its author's account data is purged", async () => {
    await deleteRemoteActorData(db, REMOTE);
    const conv = await db
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .bind(CONVERSATION)
      .first<{ id: string }>();
    expect(conv).toBeNull();
  });
});
