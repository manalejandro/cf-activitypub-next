import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import {
  suspendAccount,
  unsuspendAccount,
  blockDomain,
  resolveReport,
  dismissReport,
  deleteStatus,
} from "@/lib/moderation/actions";

const db = env.DB;

const ENV = {
  DB: {} as D1Database,
  INSTANCE_URL: "https://cf-ap.example",
} as unknown as Parameters<typeof suspendAccount>[0];

const PEM = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----";

async function insertActor(id: string, username: string, domain: string, opts: { isLocal?: boolean; email?: string | null; suspended?: boolean } = {}) {
  await db.prepare(
    `INSERT INTO actors (id, username, domain, display_name, public_key_pem, private_key_pem, is_local, is_bot,
       manually_approves_followers, discoverable, followers_count, following_count, statuses_count,
       email, password_hash, email_verified, suspended, inbox)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, 0, 0, 0, ?, NULL, 1, ?, ?)`
  ).bind(
    id,
    username.toLowerCase(),
    domain.toLowerCase(),
    username,
    PEM,
    opts.isLocal ? "priv" : null,
    opts.isLocal ? 1 : 0,
    opts.email ?? null,
    opts.suspended ? 1 : 0,
    opts.isLocal ? `https://${domain}/users/${username.toLowerCase()}/inbox` : null
  ).run();
}

async function countLog(targetType: string, targetId: string, action: string): Promise<number> {
  const row = (await db.prepare(
    "SELECT COUNT(*) AS c FROM moderation_log WHERE target_type = ? AND target_id = ? AND action = ?"
  ).bind(targetType, targetId, action).first<{ c: number }>()) as { c: number };
  return row.c ?? 0;
}

beforeEach(async () => {
  await resetTestDatabase();
  (ENV as { DB: typeof db }).DB = db;
});

describe("suspendAccount / unsuspendAccount", () => {
  it("suspends an account, clears its content, and audits the action", async () => {
    await insertActor("https://cf-ap.example/users/ale", "ale", "cf-ap.example", { isLocal: true, email: "ale@example.com" });
    db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, content_warning, sensitive, visibility, is_local)
       VALUES ('obj1', 'Note', 'https://cf-ap.example/users/ale', '<p>toxic</p>', NULL, 0, 'public', 1)`
    ).run();

    const res = await suspendAccount(ENV, { actorId: "https://cf-ap.example/users/ale", reason: "spam", source: "ai", confidence: "high" });
    expect(res.applied).toBe(true);
    expect(res.action).toBe("suspended");

    const actor = await db.prepare("SELECT suspended FROM actors WHERE id = ?").bind("https://cf-ap.example/users/ale").first<{ suspended: number }>();
    expect(actor?.suspended).toBe(1);
    const obj = await db.prepare("SELECT content, sensitive FROM objects WHERE id = 'obj1'").first<{ content: string | null; sensitive: number }>();
    expect(obj?.content).toBeNull();
    expect(obj?.sensitive).toBe(1);
    expect(await countLog("account", "https://cf-ap.example/users/ale", "suspended")).toBe(1);
  });

  it("is idempotent — does not double-suspend or double-log", async () => {
    await insertActor("https://cf-ap.example/users/ale", "ale", "cf-ap.example", { isLocal: true, suspended: true });
    const res = await suspendAccount(ENV, { actorId: "https://cf-ap.example/users/ale", reason: "again" });
    expect(res.applied).toBe(false);
    expect(await countLog("account", "https://cf-ap.example/users/ale", "suspended")).toBe(0);
  });

  it("unsuspends a suspended account and audits the action", async () => {
    await insertActor("https://cf-ap.example/users/ale", "ale", "cf-ap.example", { isLocal: true, suspended: true });
    const res = await unsuspendAccount(ENV, { actorId: "https://cf-ap.example/users/ale", reason: "reinstated" });
    expect(res.applied).toBe(true);
    const actor = await db.prepare("SELECT suspended FROM actors WHERE id = ?").bind("https://cf-ap.example/users/ale").first<{ suspended: number }>();
    expect(actor?.suspended).toBe(0);
    expect(await countLog("account", "https://cf-ap.example/users/ale", "unsuspended")).toBe(1);
  });

  it("returns applied=false for a non-suspended account", async () => {
    await insertActor("https://cf-ap.example/users/ale", "ale", "cf-ap.example", { isLocal: true });
    const res = await unsuspendAccount(ENV, { actorId: "https://cf-ap.example/users/ale" });
    expect(res.applied).toBe(false);
  });
});

describe("blockDomain", () => {
  it("inserts a domain block and suspends all cached remote accounts of the domain", async () => {
    await insertActor("https://spam.example/users/a", "a", "spam.example");
    await insertActor("https://spam.example/users/b", "b", "spam.example");

    const res = await blockDomain(ENV, { domain: "spam.example", instanceDomain: "cf-ap.example", reason: "abuse" });
    expect(res.applied).toBe(true);

    const block = await db.prepare("SELECT domain FROM domain_blocks WHERE domain = 'spam.example'").first<{ domain: string }>();
    expect(block?.domain).toBe("spam.example");
    const suspended = await db.prepare("SELECT COUNT(*) AS c FROM actors WHERE domain = 'spam.example' AND suspended = 1").first<{ c: number }>() as { c: number }; 
    expect(suspended.c).toBe(2);
    expect(await countLog("domain", "spam.example", "blocked_domain")).toBe(1);
  });

  it("refuses to block the instance's own domain", async () => {
    const res = await blockDomain(ENV, { domain: "cf-ap.example", instanceDomain: "cf-ap.example" });
    expect(res.applied).toBe(false);
    expect((await db.prepare("SELECT COUNT(*) AS c FROM domain_blocks").first<{ c: number }>())?.c ?? 0).toBe(0);
  });

  it("normalizes case and whitespace in the domain", async () => {
    const res = await blockDomain(ENV, { domain: "  Spam.Example  ", instanceDomain: "cf-ap.example" });
    expect(res.applied).toBe(true);
    const block = await db.prepare("SELECT domain FROM domain_blocks").first<{ domain: string }>();
    expect(block?.domain).toBe("spam.example");
  });
});

describe("resolveReport / dismissReport", () => {
  async function insertReport(id: string, actionTaken = 0) {
    await insertActor("https://cf-ap.example/users/ale", "ale", "cf-ap.example", { isLocal: true });
    await insertActor("https://cf-ap.example/users/bob", "bob", "cf-ap.example", { isLocal: true });
    await db.prepare(
      `INSERT INTO reports (id, actor_id, target_id, status_ids, comment, category, forwarded, action_taken)
       VALUES (?, 'https://cf-ap.example/users/ale', 'https://cf-ap.example/users/bob', NULL, 'spam', 'spam', 0, ?)`
    ).bind(id, actionTaken).run();
  }

  it("marks a report resolved and appends the resolution note", async () => {
    await insertReport("rep1");
    const res = await resolveReport(ENV, { reportId: "rep1", reason: "actioned", source: "ai", confidence: "high" });
    expect(res.applied).toBe(true);

    const report = await db.prepare("SELECT action_taken, comment FROM reports WHERE id = 'rep1'").first<{ action_taken: number; comment: string }>();
    expect(report?.action_taken).toBe(1);
    expect(report?.comment).toContain("actioned");
    expect(await countLog("report", "rep1", "resolved")).toBe(1);
  });

  it("does not resolve a report that does not exist", async () => {
    const res = await resolveReport(ENV, { reportId: "nope" });
    expect(res.applied).toBe(false);
    expect(await countLog("report", "nope", "resolved")).toBe(0);
  });

  it("dismisses a report by deleting it", async () => {
    await insertReport("rep2");
    const res = await dismissReport(ENV, { reportId: "rep2", reason: "unfounded", source: "ai", confidence: "high" });
    expect(res.applied).toBe(true);

    const report = await db.prepare("SELECT id FROM reports WHERE id = 'rep2'").first();
    expect(report).toBeNull();
    expect(await countLog("report", "rep2", "dismissed")).toBe(1);
  });
});

describe("deleteStatus", () => {
  it("soft-deletes a status (strips content, marks sensitive) and audits it", async () => {
    await insertActor("https://cf-ap.example/users/ale", "ale", "cf-ap.example", { isLocal: true });
    db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, content_warning, sensitive, visibility, is_local)
       VALUES ('obj1', 'Note', 'https://cf-ap.example/users/ale', '<p>bad</p>', NULL, 0, 'public', 1)`
    ).run();

    const res = await deleteStatus(ENV, { objectId: "obj1", reason: "spam", source: "heuristic", confidence: "high" });
    expect(res.applied).toBe(true);

    const obj = await db.prepare("SELECT content, sensitive FROM objects WHERE id = 'obj1'").first<{ content: string | null; sensitive: number }>();
    expect(obj?.content).toBeNull();
    expect(obj?.sensitive).toBe(1);
    expect(await countLog("status", "obj1", "deleted")).toBe(1);
  });

  it("is idempotent via hadAction", async () => {
    await insertActor("https://cf-ap.example/users/ale", "ale", "cf-ap.example", { isLocal: true });
    db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, content_warning, sensitive, visibility, is_local)
       VALUES ('obj1', 'Note', 'https://cf-ap.example/users/ale', '<p>bad</p>', NULL, 0, 'public', 1)`
    ).run();
    await deleteStatus(ENV, { objectId: "obj1", reason: "spam" });
    const again = await deleteStatus(ENV, { objectId: "obj1", reason: "spam" });
    expect(again.applied).toBe(false);
    expect(await countLog("status", "obj1", "deleted")).toBe(1);
  });
});