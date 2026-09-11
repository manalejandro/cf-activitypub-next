// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

const safeFetch = vi.hoisted(() => vi.fn());

vi.mock("@/lib/activitypub/federation", () => ({
  safeFetch,
  collectFollowerInboxes: vi.fn().mockResolvedValue([]),
  validateOutboundUrl: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("@/lib/activitypub/queue", () => ({
  enqueueDeliveries: vi.fn().mockResolvedValue(undefined),
}));

import { syncRemoteCollections } from "@/lib/activitypub/collections";

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

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let db: D1Database;

beforeEach(async () => {
  safeFetch.mockReset();
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;
  const insert = db.prepare(
    `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, collections_url)
     VALUES (?,?,?,?,?,?,?)`
  );
  await insert.bind("https://remote.example/users/alice", "alice", "remote.example", "k", null, 0, "https://remote.example/users/alice/featured_collections").run();
  await insert.bind("https://remote.example/users/bob", "bob", "remote.example", "k", null, 0, null).run();
  await insert.bind("https://local.example/users/me", "me", "local.example", "k", "p", 1, null).run();
});

describe("syncRemoteCollections", () => {
  it("caches remote FeaturedCollections and their known items", async () => {
    safeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/featured_collections")) {
        return jsonResponse({
          type: "Collection",
          totalItems: 1,
          first: "https://remote.example/users/alice/featured_collections?page=1",
        });
      }
      if (url.includes("page=1")) {
        return jsonResponse({
          type: "CollectionPage",
          orderedItems: [{
            id: "https://remote.example/featured_collections/1",
            type: "FeaturedCollection",
            name: "Nice folks",
            summary: "A list",
            url: "https://remote.example/c/1",
            sensitive: false,
            discoverable: true,
            published: "2026-01-01T00:00:00Z",
            updated: "2026-01-02T00:00:00Z",
            topic: { type: "Hashtag", name: "#people" },
            orderedItems: [
              { id: "https://remote.example/featured_items/1", type: "FeaturedItem", featuredObject: "https://remote.example/users/bob" },
              { id: "https://remote.example/featured_items/2", type: "FeaturedItem", featuredObject: "https://local.example/users/me" },
              { id: "https://remote.example/featured_items/3", type: "FeaturedItem", featuredObject: "https://unknown.example/users/x" },
            ],
          }],
        });
      }
      return null;
    });

    await syncRemoteCollections(db, undefined, "https://remote.example/users/alice", { force: true });

    const col = await db
      .prepare("SELECT * FROM collections WHERE id = ?")
      .bind("https://remote.example/featured_collections/1")
      .first<Record<string, unknown>>();
    expect(col).toBeTruthy();
    expect(col!.name).toBe("Nice folks");
    expect(col!.local).toBe(0);
    expect(col!.discoverable).toBe(1);
    expect(col!.tag_name).toBe("people");
    expect(col!.url).toBe("https://remote.example/c/1");

    const items = await db
      .prepare("SELECT account_id FROM collection_items WHERE collection_id = ? ORDER BY created_at ASC")
      .bind(col!.id as string)
      .all<{ account_id: string }>();
    // unknown.example is not cached locally → skipped (FK on actors)
    expect(items.results.map((r) => r.account_id)).toEqual([
      "https://remote.example/users/bob",
      "https://local.example/users/me",
    ]);
  });

  it("skips syncing while the KV throttle marker is present", async () => {
    const kv = { get: vi.fn().mockResolvedValue("1"), put: vi.fn() };
    await syncRemoteCollections(db, kv as never, "https://remote.example/users/alice");
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("does nothing for actors without a collections URL", async () => {
    await syncRemoteCollections(db, undefined, "https://remote.example/users/bob", { force: true });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
