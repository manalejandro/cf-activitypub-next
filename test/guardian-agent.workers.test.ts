import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

// The chat tools never call the model here; the DO is exercised through HTTP.
vi.mock("@/lib/streaming/broadcast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/streaming/broadcast")>()),
  broadcastAccountUpdate: vi.fn(async () => {}),
}));

import { buildGuardianTools } from "@/lib/guardian/tools";
import { getGuardianSnapshot } from "@/lib/guardian/snapshot";
import { routeGuardianAgent, isAgentRequest } from "@/lib/guardian/routing";
import { GuardianAgentDO } from "@/lib/guardian/agent";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const ADMIN = `${BASE}/users/admin`;
const MOD = `${BASE}/users/mod`;
const TOKEN = "guardian-token";
const MOD_TOKEN = "guardian-mod-token";

async function seedActor(id: string, role: string, token: string): Promise<void> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, email, email_verified)
       VALUES (?, ?, ?, 'pub', 'priv', 1, 1, ?, ?, 1)`
    )
    .bind(id, username, new URL(id).hostname, role, `${username}@example.com`)
    .run();
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(`t-${token}`, id, token)
    .run();
}

function agentRequest(token?: string): NextRequest {
  return new NextRequest(`${BASE}/agents/guardian-agent/instance`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(ADMIN, "admin", TOKEN);
  await seedActor(MOD, "moderator", MOD_TOKEN);
});

describe("the Guardian agent", () => {
  it("is only routed for the agents namespace", async () => {
    expect(isAgentRequest(new Request(`${BASE}/agents/guardian-agent/instance`))).toBe(true);
    expect(isAgentRequest(new Request(`${BASE}/admin/guardian`))).toBe(false);
    expect(await routeGuardianAgent(new Request(`${BASE}/admin/guardian`), env)).toBeNull();
  });

  it("refuses anonymous callers and moderators", async () => {
    const anonymous = await routeGuardianAgent(agentRequest(), env);
    expect(anonymous?.status).toBe(401);

    const moderator = await routeGuardianAgent(agentRequest(MOD_TOKEN), env);
    expect(moderator?.status).toBe(403);
  });

  it("answers an administrator with the moderation snapshot", async () => {
    const res = await routeGuardianAgent(agentRequest(TOKEN), env);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { agent: string; model: string; auditModel: string; snapshot: { accounts: { local: number } } };
    expect(body.agent).toBe("guardian");
    expect(body.model).toBeTruthy();
    // Actions the agent performs are audited under this model id.
    expect(body.auditModel).toBe("guardian-agent");
    expect(body.snapshot.accounts.local).toBeGreaterThanOrEqual(2);
  });

  it("exposes its admin actions over RPC", () => {
    // The callable metadata is registered explicitly (`exposeMethod`) because
    // decorator syntax crashes the deployed Worker — see lib/guardian/agent.ts.
    const probe = Object.create(GuardianAgentDO.prototype) as GuardianAgentDO;
    expect([...probe.getCallableMethods().keys()].sort()).toEqual(["refreshSnapshot", "setModel"]);
  });
});

describe("the Guardian's tools", () => {
  it("reports the instance picture from the database", async () => {
    const tools = buildGuardianTools(env);
    const overview = (await (tools.instance_overview.execute as (input: unknown) => Promise<unknown>)({})) as {
      accounts: { local: number };
      open_reports: number;
    };
    expect(overview.accounts.local).toBe(2);
    expect(overview.open_reports).toBe(0);
  });

  it("lists reports with their target and evidence count", async () => {
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified)
         VALUES ('https://remote.example/users/spammer', 'spammer', 'remote.example', 'pub', NULL, 0, 1, 's@example.com', 1)`
      )
      .run();
    await db
      .prepare(
        `INSERT INTO reports (id, actor_id, target_id, status_ids, comment, category, forwarded, created_at)
         VALUES ('r1', ?, 'https://remote.example/users/spammer', ?, 'vende seguidores', 'spam', 1, datetime('now'))`
      )
      .bind(ADMIN, JSON.stringify(["abc", "def"]))
      .run();

    const tools = buildGuardianTools(env);
    const reports = (await (tools.list_reports.execute as (input: unknown) => Promise<unknown>)({ status: "open", limit: 10 })) as {
      target: string;
      category: string;
      evidence_statuses: number;
      forwarded_to_origin: boolean;
    }[];
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      target: "@spammer@remote.example",
      category: "spam",
      evidence_statuses: 2,
      forwarded_to_origin: true,
    });
  });

  it("describes one account with its reports and decisions", async () => {
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, suspended, email, email_verified)
         VALUES ('https://remote.example/users/spammer', 'spammer', 'remote.example', 'pub', NULL, 0, 1, 1, 's@example.com', 1)`
      )
      .run();

    const tools = buildGuardianTools(env);
    const account = (await (tools.get_account.execute as (input: unknown) => Promise<unknown>)({
      account: "@spammer@remote.example",
    })) as { account: string; suspended: boolean };
    expect(account.account).toBe("@spammer@remote.example (suspended)");
    expect(account.suspended).toBe(true);

    const missing = (await (tools.get_account.execute as (input: unknown) => Promise<unknown>)({ account: "@nobody" })) as { error?: string };
    expect(missing.error).toContain("No account matches");
  });

  it("suspends an account through the audited moderation engine", async () => {
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified)
         VALUES ('https://remote.example/users/spammer', 'spammer', 'remote.example', 'pub', NULL, 0, 1, 's@example.com', 1)`
      )
      .run();

    const tools = buildGuardianTools(env);
    const result = (await (tools.suspend_account.execute as (input: unknown) => Promise<unknown>)({
      account: "@spammer@remote.example",
      reason: "spam repetido",
    })) as { applied: boolean };

    expect(result.applied).toBe(true);
    const row = await db
      .prepare("SELECT suspended, suspension_origin FROM actors WHERE id = 'https://remote.example/users/spammer'")
      .first<{ suspended: number; suspension_origin: string | null }>();
    expect(row).toMatchObject({ suspended: 1, suspension_origin: "local" });

    const log = await db
      .prepare("SELECT action, model FROM moderation_log WHERE target_id = 'https://remote.example/users/spammer'")
      .first<{ action: string; model: string }>();
    expect(log).toMatchObject({ action: "suspended", model: "guardian-agent" });
  });

  it("reads the moderation snapshot the panel renders", async () => {
    const snapshot = await getGuardianSnapshot(env);
    expect(snapshot.accounts.local).toBe(2);
    expect(snapshot.open_reports).toBe(0);
    expect(snapshot.registrations_pending).toBe(0);
  });
});
