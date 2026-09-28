// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

import { cleanupUnusedOAuthApps } from "@/lib/db";

class D1Adapter {
  private sql = new DatabaseSync(":memory:");

  constructor(schemaSql: string) {
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(schemaSql);
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

const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
// The schema ships the insert-time prune trigger; the cron tests exercise the
// batch cleanup, so they drop it (the trigger has its own describe below).
const schemaWithoutTrigger = `${schema}\nDROP TRIGGER IF EXISTS prune_unused_oauth_apps;`;
const LOCAL_ACTOR = "https://cf-ap.com/users/ale";
const REMOTE_ACTOR = "https://remote.example/users/fan";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

// Raw inserts: the production helpers delegate `created_at` to the column
// default, and these tests need rows old enough for the sweep.
async function seedApp(db: D1Database, name: string, createdAt: string): Promise<string> {
  const id = `app-${name}`;
  await db
    .prepare(
      `INSERT INTO oauth_apps (id, name, redirect_uri, scopes, client_id, client_secret, created_at)
       VALUES (?, ?, 'urn:ietf:wg:oauth:2.0:oob', 'read', ?, 'secret', ?)`
    )
    .bind(id, name, `cid-${name}`, createdAt)
    .run();
  return id;
}

async function seedToken(
  db: D1Database,
  appId: string,
  actorId: string | null,
  createdAt: string,
  expiresAt: string | null
): Promise<void> {
  const id = `${appId}-${actorId ?? "app"}-${createdAt}`;
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'read', ?, ?)`
    )
    .bind(id, actorId, appId, `token-${id}`, createdAt, expiresAt)
    .run();
}

async function appNames(db: D1Database): Promise<string[]> {
  const rows = await db.prepare("SELECT name FROM oauth_apps ORDER BY name").bind().all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

async function tokenCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").bind().first<{ n: number }>();
  return row?.n ?? 0;
}

describe("cleanupUnusedOAuthApps", () => {
  let db: D1Database;

  beforeEach(async () => {
    db = new D1Adapter(schemaWithoutTrigger) as unknown as D1Database;
    await db
      .prepare(
        "INSERT INTO actors (id, username, domain, public_key_pem, is_local, email, email_verified) VALUES (?, ?, ?, ?, 1, ?, 1)"
      )
      .bind(LOCAL_ACTOR, "ale", "cf-ap.com", "pem", "ale@cf-ap.com")
      .run();
  });

  it("keeps an app whose user token belongs to a suspended or unverified account", async () => {
    const bot = "https://cf-ap.com/users/suspended1";
    await db
      .prepare(
        "INSERT INTO actors (id, username, domain, public_key_pem, is_local, email, email_verified, suspended) VALUES (?, ?, ?, ?, 1, ?, 1, 1)"
      )
      .bind(bot, "suspended1", "cf-ap.com", "pem", "bot2@example.com")
      .run();
    const parasitized = await seedApp(db, "dialect_signup_v1", daysAgo(20));
    await seedToken(db, parasitized, bot, daysAgo(20), null);

    await cleanupUnusedOAuthApps(db);

    expect(await appNames(db)).toEqual(["dialect_signup_v1"]);
  });

  it("keeps apps a registered local user authorized, even with expired tokens", async () => {
    const app = await seedApp(db, "legit", daysAgo(30));
    await seedToken(db, app, LOCAL_ACTOR, daysAgo(30), hoursAgo(1));

    const cleaned = await cleanupUnusedOAuthApps(db);

    // The user's token (expired or not) is the record that keeps the app.
    expect(await appNames(db)).toEqual(["legit"]);
    expect(cleaned.apps).toBe(0);
    expect(await tokenCount(db)).toBe(1);
    expect(cleaned.tokens).toBe(0);
  });

  it("removes probe apps: app-level token only, app past the grace window", async () => {
    const probe = await seedApp(db, "Mastodon Web", daysAgo(10));
    await seedToken(db, probe, null, hoursAgo(30), hoursAgo(29));

    const cleaned = await cleanupUnusedOAuthApps(db);

    expect(await appNames(db)).toEqual([]);
    expect(cleaned.apps).toBe(1);
    expect(await tokenCount(db)).toBe(0);
    expect(cleaned.tokens).toBe(1);
  });

  it("leaves a fresh app-level token (onboarding in progress) alone", async () => {
    const app = await seedApp(db, "new-client", daysAgo(10));
    await seedToken(db, app, null, hoursAgo(1), hoursFromNow(1));

    const cleaned = await cleanupUnusedOAuthApps(db);

    expect(await appNames(db)).toEqual(["new-client"]);
    expect(cleaned.apps).toBe(0);
    expect(cleaned.tokens).toBe(0);
  });

  it("keeps apps inside the one-hour grace window and drops older unused ones", async () => {
    await seedApp(db, "recent", minutesAgo(10));
    await seedApp(db, "old", daysAgo(20));

    const cleaned = await cleanupUnusedOAuthApps(db);

    expect(await appNames(db)).toEqual(["recent"]);
    expect(cleaned.apps).toBe(1);
  });

  it("drops an app left over an hour without tokens (crawler registrations)", async () => {
    await seedApp(db, "crawler", hoursAgo(2));

    const cleaned = await cleanupUnusedOAuthApps(db);

    expect(await appNames(db)).toEqual([]);
    expect(cleaned.apps).toBe(1);
  });

  it("keeps an app a remote actor has a token for (user-bound token exists)", async () => {
    const app = await seedApp(db, "remote-token", daysAgo(20));
    await seedToken(db, app, REMOTE_ACTOR, daysAgo(20), null);

    await cleanupUnusedOAuthApps(db);

    expect(await appNames(db)).toEqual(["remote-token"]);
  });

  it("caps how much is deleted per run", async () => {
    for (let i = 0; i < 3; i++) {
      const app = await seedApp(db, `probe-${i}`, daysAgo(10));
      await seedToken(db, app, null, hoursAgo(30), hoursAgo(29));
    }

    const first = await cleanupUnusedOAuthApps(db, { limit: 1 });
    expect(first.apps).toBe(1);

    const second = await cleanupUnusedOAuthApps(db, { limit: 10 });
    expect(second.apps).toBe(2);
    expect(await appNames(db)).toEqual([]);
  });
});

describe("prune trigger (schema)", () => {
  let db: D1Database;

  beforeEach(() => {
    db = new D1Adapter(schema) as unknown as D1Database;
  });

  it("prunes an unused app older than the grace window on insert", async () => {
    await seedApp(db, "crawler", hoursAgo(2));

    expect(await appNames(db)).toEqual([]);
  });

  it("keeps fresh apps and apps with a user token", async () => {
    await seedApp(db, "fresh", minutesAgo(5));

    const token = "legit-token";
    // Seed inside the grace window (the insert trigger would prune an old app
    // before its token existed), then backdate: the user token keeps it alive.
    const app = await seedApp(db, "legit", minutesAgo(5));
    await db
      .prepare(
        `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'read', ?, NULL)`
      )
      .bind(token, "https://cf-ap.com/users/ale", app, `access-${token}`, daysAgo(30))
      .run();
    await db
      .prepare("UPDATE oauth_apps SET created_at = ? WHERE id = ?")
      .bind(daysAgo(30), app)
      .run();
    // Any further insert runs the trigger again.
    await seedApp(db, "another-crawler", hoursAgo(3));

    expect(await appNames(db)).toEqual(["fresh", "legit"]);
  });
});
