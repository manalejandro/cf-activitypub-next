// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

const federation = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  validateOutboundUrl: vi.fn(() => ({ valid: true })),
}));

vi.mock("@/lib/activitypub/federation", () => federation);

import {
  deliveryRetryDelay,
  fetchInstanceMetadata,
  instanceDownKey,
  normalizeDomain,
  parseRetryAfter,
  recordInstanceDeliveryFailure,
  recordInstanceDeliverySuccess,
  recordInstanceInboundActivity,
} from "@/lib/activitypub/instances";
import {
  expireDormantInstanceMetadata,
  getInstance,
  listInstancesDueForRefresh,
  recordInstanceFailure,
  upsertInstanceMetadata,
} from "@/lib/db";

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

class FakeKV {
  store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

const DAY = 86_400_000;

let db: D1Database;
let kv: FakeKV;

beforeEach(async () => {
  federation.safeFetch.mockReset();
  federation.validateOutboundUrl.mockReturnValue({ valid: true });
  kv = new FakeKV();
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  db = new D1Adapter(schema) as unknown as D1Database;
});

describe("instance helpers", () => {
  it("normalizes domains and rejects junk", () => {
    expect(normalizeDomain("Example.COM.")).toBe("example.com");
    expect(normalizeDomain("https://Remote.Example/users/x")).toBe("remote.example");
    expect(normalizeDomain("remote.example:8080")).toBe("remote.example");
    expect(normalizeDomain("no-dot")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
  });

  it("uses Mastodon's quartic retry schedule capped at 24h", () => {
    expect(deliveryRetryDelay(1, () => 0)).toBe(16);
    expect(deliveryRetryDelay(2, () => 0)).toBe(31);
    expect(deliveryRetryDelay(3, () => 0)).toBe(96);
    expect(deliveryRetryDelay(2, () => 0)).toBeGreaterThan(deliveryRetryDelay(1, () => 0));
    expect(deliveryRetryDelay(100, () => 1)).toBe(86_400);
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("nonsense")).toBeNull();
    const inFive = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfter(inFive);
    expect(parsed).toBeGreaterThanOrEqual(4);
    expect(parsed).toBeLessThanOrEqual(5);
    expect(parseRetryAfter("999999")).toBe(86_400);
  });
});

describe("fetchInstanceMetadata", () => {
  it("reads NodeInfo 2.1/2.0 and parses software/title/languages", async () => {
    federation.safeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/.well-known/nodeinfo")) {
        return jsonResponse({
          links: [
            { rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: "https://remote.example/nodeinfo/2.1" },
          ],
        });
      }
      if (url.endsWith("/nodeinfo/2.1")) {
        return jsonResponse({
          software: { name: "Mastodon", version: "4.3.0" },
          metadata: { nodeName: "Remote", nodeDescription: "A server", languages: ["en", "es"] },
          openRegistrations: true,
        });
      }
      return null;
    });

    const meta = await fetchInstanceMetadata("remote.example");
    expect(meta).toEqual({
      software: "mastodon",
      version: "4.3.0",
      title: "Remote",
      description: "A server",
      openRegistrations: true,
      languages: ["en", "es"],
    });
  });

  it("falls back to Mastodon /api/v2/instance", async () => {
    federation.safeFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/.well-known/nodeinfo")) return null;
      if (url.endsWith("/api/v2/instance")) {
        return jsonResponse({
          title: "Fallback",
          short_description: "No nodeinfo",
          software: { name: "mastodon", version: "4.2.0" },
          registrations: { enabled: false },
          languages: ["fr"],
        });
      }
      return null;
    });

    const meta = await fetchInstanceMetadata("remote.example");
    expect(meta?.title).toBe("Fallback");
    expect(meta?.openRegistrations).toBe(false);
    expect(meta?.version).toBe("4.2.0");
  });

  it("returns null when nothing answers", async () => {
    federation.safeFetch.mockResolvedValue(null);
    expect(await fetchInstanceMetadata("remote.example")).toBeNull();
  });
});

describe("availability tracker", () => {
  it("marks unavailable after failures on 7 distinct UTC days", async () => {
    const start = Date.UTC(2026, 0, 1, 12);
    for (let i = 0; i < 6; i++) {
      const instance = await recordInstanceFailure(db, "down.example", 0, 7, new Date(start + i * DAY));
      expect(instance?.unavailable).toBe(false);
    }
    // Same day repeated does not count twice.
    await recordInstanceFailure(db, "down.example", 0, 7, new Date(start + 5 * DAY + 3_600_000));
    let row = await getInstance(db, "down.example");
    expect(row?.failureDays).toBe(6);

    row = await recordInstanceFailure(db, "down.example", 0, 7, new Date(start + 6 * DAY));
    expect(row?.unavailable).toBe(true);
    expect(row?.unavailableAt).toBeTruthy();

    // A success clears everything.
    await recordInstanceDeliverySuccess(db, kv, "down.example");
    row = await getInstance(db, "down.example");
    expect(row?.unavailable).toBe(false);
    expect(row?.failureDays).toBe(0);
    expect(row?.lastOkAt).toBeTruthy();
  });

  it("sets and clears the KV down marker around the threshold", async () => {
    const start = Date.UTC(2026, 0, 1, 12);
    for (let i = 0; i < 7; i++) {
      await recordInstanceDeliveryFailure(db, kv, "dead.example", 0, 7);
      // advance a day for each failure
      await db.prepare("UPDATE instances SET last_failure_day = ? WHERE domain = ?")
        .bind(new Date(start + i * DAY).toISOString().slice(0, 10), "dead.example").run();
    }
    expect(await kv.get(instanceDownKey("dead.example"))).toBe("1");

    await recordInstanceDeliverySuccess(db, kv, "dead.example");
    expect(await kv.get(instanceDownKey("dead.example"))).toBeNull();
  });

  it("clears an unavailable host when it reaches us (signed inbound activity)", async () => {
    const start = Date.UTC(2026, 0, 1, 12);
    for (let i = 0; i < 7; i++) {
      await recordInstanceFailure(db, "revive.example", 0, 7, new Date(start + i * DAY));
    }
    await kv.put(instanceDownKey("revive.example"), "1");

    const seenBefore = (await getInstance(db, "revive.example"))!.lastSeenAt;
    await recordInstanceInboundActivity(db, kv, "revive.example");

    const row = await getInstance(db, "revive.example");
    expect(row?.unavailable).toBe(false);
    expect(await kv.get(instanceDownKey("revive.example"))).toBeNull();
    expect(row?.lastSeenAt).toBeTruthy();
    void seenBefore;
  });
});

describe("metadata refresh scheduling and expiry", () => {
  async function seedActors() {
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://old.example/users/ghost', 'ghost', 'old.example', 'k', NULL, 0)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://liked.example/users/friend', 'friend', 'liked.example', 'k', NULL, 0)`
    ).bind().run();
  }

  it("lists only due, non-suspended instances", async () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await db.prepare("INSERT INTO instances (domain, next_refresh_at) VALUES (?, ?)").bind("due.example", past).run();
    await db.prepare("INSERT INTO instances (domain, next_refresh_at) VALUES (?, ?)").bind("later.example", future).run();
    await db.prepare("INSERT INTO instances (domain, next_refresh_at, suspended) VALUES (?, ?, 1)").bind("paused.example", past).run();
    await db.prepare("INSERT INTO instances (domain, next_refresh_at) VALUES (?, NULL)").bind("dormant.example").run();

    const due = await listInstancesDueForRefresh(db, 10);
    expect(due).toEqual(["due.example"]);
  });

  it("expires metadata of dormant instances but keeps followed ones", async () => {
    await seedActors();
    const old = new Date(Date.now() - 100 * DAY).toISOString();
    const future = new Date(Date.now() + DAY).toISOString();
    for (const [domain, follows] of [["old.example", false], ["liked.example", true]] as const) {
      await upsertInstanceMetadata(db, domain, {
        software: "mastodon", version: "4.3.0", title: domain, description: null,
        openRegistrations: null, languages: [], nextRefreshAt: future,
      });
      await db.prepare("UPDATE instances SET last_seen_at = ? WHERE domain = ?").bind(old, domain).run();
      if (follows) {
        await db.prepare(
          "INSERT INTO follows (id, actor_id, target_id, state) VALUES (?, 'https://local.example/users/me', 'https://liked.example/users/friend', 'accepted')"
        ).bind(`f-${domain}`).run();
      }
    }

    await expireDormantInstanceMetadata(db, 30);

    const expired = await getInstance(db, "old.example");
    expect(expired?.software).toBeNull();
    expect(expired?.nextRefreshAt).toBeNull();

    const kept = await getInstance(db, "liked.example");
    expect(kept?.software).toBe("mastodon");
    expect(kept?.nextRefreshAt).toBe(future);
  });
});
