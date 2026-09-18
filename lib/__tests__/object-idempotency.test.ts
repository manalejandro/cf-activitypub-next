// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

import { createAttachment, createObject, getObjectById, updateObject } from "@/lib/db";

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

const ACTOR = "https://remote.example/users/fan";
const OBJ = "https://remote.example/objects/1";

function objectDoc(content: string) {
  return {
    id: OBJ,
    type: "Note",
    actorId: ACTOR,
    content,
    contentWarning: null,
    sensitive: false,
    visibility: "public" as const,
    inReplyToId: null,
    quoteId: null,
    language: "en",
    url: OBJ,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-09-17T10:00:00.000Z",
    local: false,
    raw: JSON.stringify({ id: OBJ, type: "Note", content, tag: [{ type: "Hashtag", name: "#test" }] }),
  };
}

let db: D1Database;

beforeEach(async () => {
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;
  await db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
     VALUES (?, 'fan', 'remote.example', 'k', NULL, 0)`
  ).bind(ACTOR).run();
});

describe("idempotent remote object ingestion", () => {
  it("maintains the link-post flag on create and edit (Guardian count)", async () => {
    await createObject(db, objectDoc("no links here"));
    const noLink = await db.prepare("SELECT has_link FROM objects WHERE id = ?").bind(OBJ).first<{ has_link: number }>();
    expect(noLink?.has_link).toBe(0);

    // Editing the content recomputes it (the patrol counts via the index).
    await updateObject(db, OBJ, { content: '<p>see https://example.com</p>' });
    const withLink = await db.prepare("SELECT has_link FROM objects WHERE id = ?").bind(OBJ).first<{ has_link: number }>();
    expect(withLink?.has_link).toBe(1);
  });

  it("marks a post whose content contains an uppercase link (LIKE semantics)", async () => {
    const obj = { ...objectDoc("<p>HTTP://EXAMPLE.COM</p>") };
    await createObject(db, obj);
    const row = await db.prepare("SELECT has_link FROM objects WHERE id = ?").bind(OBJ).first<{ has_link: number }>();
    expect(row?.has_link).toBe(1);
  });

  it("returns true on the first insert and false on a concurrent duplicate", async () => {
    expect(await createObject(db, objectDoc("first"))).toBe(true);
    // A second delivery (shared inbox + user inbox, retry…) must not throw.
    expect(await createObject(db, objectDoc("second"))).toBe(false);

    const stored = await getObjectById(db, OBJ);
    expect(stored?.content).toBe("first");
  });

  it("does not duplicate attachments on a replayed delivery", async () => {
    await createObject(db, objectDoc("first"));
    const att = {
      id: "att-1",
      objectId: OBJ,
      type: "image",
      url: "https://remote.example/a.png",
      remoteUrl: "https://remote.example/a.png",
      description: null,
      blurhash: null,
      width: null,
      height: null,
      fileSize: null,
      mimeType: "image/png",
      sensitive: false,
      createdAt: "2026-09-17T10:00:00.000Z",
    };
    await createAttachment(db, att);
    await createAttachment(db, att);

    const rows = await db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE object_id = ?").bind(OBJ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});
