import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { sweepExpiredAccounts, expiryDate, DEFAULT_EXPIRATION_MONTHS } from "@/lib/moderation/account-expiration";
import { resolveDeliverySigningKey } from "@/lib/activitypub/queue";
import { setInstanceSetting } from "@/lib/db";

beforeAll(async () => {
  await applyTestSchema();
});

const db = env.DB;
const BASE = "https://local.example.test";

/** `n` months ago, ISO (calendar months, like the sweep). */
function monthsAgo(n: number, extraDays = 0): string {
  const date = new Date();
  date.setMonth(date.getMonth() - n);
  date.setTime(date.getTime() - extraDays * 86_400_000);
  return date.toISOString();
}

async function seedLocalActor(opts: {
  username: string;
  lastActive?: string | null;
  suspended?: boolean;
  suspendedAt?: string | null;
  email?: string | null;
  verified?: boolean;
  role?: string;
}): Promise<string> {
  const id = `${BASE}/users/${opts.username}`;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local,
                           email, email_verified, role, suspended, suspended_at, last_active_at)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.username,
      opts.email === undefined ? `${opts.username}@example.com` : opts.email,
      opts.verified === false ? 0 : 1,
      opts.role ?? "user",
      opts.suspended ? 1 : 0,
      opts.suspendedAt ?? null,
      opts.lastActive === undefined ? new Date().toISOString() : opts.lastActive
    )
    .run();
  return id;
}

/** Fake bindings the sweep accepts directly (its env is a parameter). */
function fakeEnv(overrides: Record<string, unknown> = {}) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const queued: { body: { inboxUrl: string; activityJson: string } }[] = [];
  const email = {
    send: vi.fn(async (message: { to: string; subject: string; text: string }) => {
      sent.push(message);
    }),
  };
  const queue = {
    sendBatch: vi.fn(async (messages: { body: { inboxUrl: string; activityJson: string } }[]) => {
      queued.push(...messages);
    }),
  };
  return {
    sent,
    queued,
    email,
    queue,
    env: {
      DB: db,
      KV: env.KV,
      EMAIL: email,
      FROM_EMAIL: "noreply@local.example.test",
      INSTANCE_TITLE: "Test Instance",
      INSTANCE_URL: BASE,
      R2: env.R2,
      DELIVERY_QUEUE: queue,
      ...overrides,
    } as unknown as Parameters<typeof sweepExpiredAccounts>[0],
  };
}

beforeEach(async () => {
  await resetTestStorage();
});

describe("expiryDate", () => {
  it("adds whole calendar months", () => {
    expect(expiryDate("2026-01-15T00:00:00.000Z", 12)).toBe("2027-01-15T00:00:00.000Z");
  });
});

describe("account expiration sweep", () => {
  it("warns by email 7 days before the window passes", async () => {
    // 12 months minus 3 days of inactivity → inside the 7-day window.
    await seedLocalActor({ username: "soon", lastActive: monthsAgo(DEFAULT_EXPIRATION_MONTHS, -3) });
    const fake = fakeEnv();

    const result = await sweepExpiredAccounts(fake.env);

    expect(result.warned).toBe(1);
    expect(result.warnedFinal).toBe(0);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].to).toBe("soon@example.com");
    expect(fake.sent[0].text).toContain("soon");
    // The marker prevents a second email on the next pass.
    expect(await env.KV.get(`${BASE}/users/soon` ? `expiry:warn:7:${BASE}/users/soon` : "")).toBe("1");
    const again = await sweepExpiredAccounts(fake.env);
    expect(again.warned).toBe(0);
    expect(fake.sent).toHaveLength(1);
  });

  it("sends the final warning 24 hours before the window passes", async () => {
    await seedLocalActor({ username: "last", lastActive: monthsAgo(DEFAULT_EXPIRATION_MONTHS, -0.5) });
    const fake = fakeEnv();

    const result = await sweepExpiredAccounts(fake.env);

    expect(result.warnedFinal).toBe(1);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].subject).toContain("Último aviso");
    expect(await env.KV.get(`expiry:warn:1:${BASE}/users/last`)).toBe("1");
  });

  it("suspends accounts whose window passed without a sign-in", async () => {
    const id = await seedLocalActor({ username: "idle", lastActive: monthsAgo(13) });
    const fake = fakeEnv();

    const result = await sweepExpiredAccounts(fake.env);

    expect(result.suspended).toBe(1);
    const actor = await db
      .prepare("SELECT suspended, suspended_at FROM actors WHERE id = ?")
      .bind(id)
      .first<{ suspended: number; suspended_at: string | null }>();
    expect(actor?.suspended).toBe(1);
    expect(actor?.suspended_at).toBeTruthy();

    const logged = await db
      .prepare("SELECT action, reason FROM moderation_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(id)
      .first<{ action: string; reason: string }>();
    expect(logged?.action).toBe("suspended");
    expect(logged?.reason).toContain("Inactividad");
  });

  it("purges accounts suspended for a month, federating Delete{Actor}", async () => {
    const id = await seedLocalActor({ username: "gone", lastActive: monthsAgo(14), suspended: true, suspendedAt: monthsAgo(2) });
    // A follower so the Delete has somewhere to go.
    await db
      .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local, inbox) VALUES (?,?,?,?,?,?)")
      .bind("https://remote.example/users/fan", "fan", "remote.example", "pub", 0, "https://remote.example/users/fan/inbox")
      .run();
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
      .bind("https://remote.example/users/fan", id)
      .run();

    const fake = fakeEnv();
    const result = await sweepExpiredAccounts(fake.env);

    expect(result.deleted).toBe(1);
    expect(await db.prepare("SELECT id FROM actors WHERE id = ?").bind(id).first()).toBeNull();
    expect(fake.queued).toHaveLength(1);
    expect(fake.queued[0].body.inboxUrl).toBe("https://remote.example/users/fan/inbox");
    expect(fake.queued[0].body.activityJson).toContain('"type":"Delete"');
    // Mastodon's DeleteActorSerializer shape: the bare actor URI is the object.
    expect(JSON.parse(fake.queued[0].body.activityJson).object).toBe(id);
    // The queue consumer signs at delivery time, when the actor row is gone:
    // the key must survive in KV for the queued Delete to be delivered at all.
    await expect(resolveDeliverySigningKey(env, id)).resolves.toEqual({
      keyId: `${id}#main-key`,
      privateKeyPem: "priv",
    });

    const logged = await db
      .prepare("SELECT action, reason FROM moderation_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(id)
      .first<{ action: string; reason: string }>();
    expect(logged?.action).toBe("deleted");
    expect(logged?.reason).toContain("suspendida");
  });

  it("keeps a recently suspended account", async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await seedLocalActor({ username: "recent", lastActive: monthsAgo(14), suspended: true, suspendedAt: fiveDaysAgo });
    const fake = fakeEnv();

    const result = await sweepExpiredAccounts(fake.env);

    expect(result.deleted).toBe(0);
    expect(await db.prepare("SELECT id FROM actors WHERE username = 'recent'").first()).toBeTruthy();
  });

  it("does nothing when the feature is disabled", async () => {
    await setInstanceSetting(db, "account_expiration_enabled", "false");
    const id = await seedLocalActor({ username: "idle", lastActive: monthsAgo(24) });
    const fake = fakeEnv();

    const result = await sweepExpiredAccounts(fake.env);

    expect(result).toEqual({ warned: 0, warnedFinal: 0, suspended: 0, deleted: 0 });
    expect(fake.sent).toHaveLength(0);
    expect((await db.prepare("SELECT suspended FROM actors WHERE id = ?").bind(id).first<{ suspended: number }>())?.suspended).toBe(0);
  });

  it("honours a custom window", async () => {
    await setInstanceSetting(db, "account_expiration_months", "3");
    const id = await seedLocalActor({ username: "short", lastActive: monthsAgo(4) });
    const fake = fakeEnv();

    const result = await sweepExpiredAccounts(fake.env);

    expect(result.suspended).toBe(1);
    expect((await db.prepare("SELECT suspended FROM actors WHERE id = ?").bind(id).first<{ suspended: number }>())?.suspended).toBe(1);
  });

  it("never touches administrators, moderators or reserved accounts", async () => {
    await seedLocalActor({ username: "admin", lastActive: monthsAgo(24), role: "admin" });
    await seedLocalActor({ username: "mod", lastActive: monthsAgo(24), role: "moderator" });
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, reserved, last_active_at)
         VALUES (?, 'guardian', 'local.example.test', 'pub', 'priv', 1, 1, ?)`
      )
      .bind(`${BASE}/users/guardian`, monthsAgo(24))
      .run();
    const fake = fakeEnv();

    const result = await sweepExpiredAccounts(fake.env);

    expect(result).toEqual({ warned: 0, warnedFinal: 0, suspended: 0, deleted: 0 });
    expect(fake.sent).toHaveLength(0);
    const still = await db
      .prepare("SELECT COUNT(*) AS n FROM actors WHERE suspended = 1 AND is_local = 1")
      .first<{ n: number }>();
    expect(still?.n).toBe(0);
  });

  it("skips accounts without a confirmed email for warnings but still expires them", async () => {
    await seedLocalActor({ username: "noverified", lastActive: monthsAgo(13), verified: false });
    const fake = fakeEnv();

    const result = await sweepExpiredAccounts(fake.env);

    expect(fake.sent).toHaveLength(0);
    expect(result.suspended).toBe(1);
  });
});

describe("signing in restarts the window", () => {
  it("drops the warning markers and refreshes last_active_at", async () => {
    const id = await seedLocalActor({ username: "back", lastActive: monthsAgo(11) });
    await db
      .prepare(
        "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, 'tok-back', 'read write', datetime('now'))"
      )
      .bind(id)
      .run();
    await env.KV.put(`expiry:warn:7:${id}`, "1");
    await env.KV.put(`expiry:warn:1:${id}`, "1");

    const { getAuthenticatedActor } = await import("@/lib/auth");
    const actor = await getAuthenticatedActor(
      new Request(`${BASE}/api/v1/instance`, { headers: { Authorization: "Bearer tok-back" } }),
      db
    );

    expect(actor?.id).toBe(id);
    expect(await env.KV.get(`expiry:warn:7:${id}`)).toBeNull();
    expect(await env.KV.get(`expiry:warn:1:${id}`)).toBeNull();
    const row = await db
      .prepare("SELECT last_active_at FROM actors WHERE id = ?")
      .bind(id)
      .first<{ last_active_at: string }>();
    expect(new Date(row!.last_active_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
