import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

// The vector memory needs the remote Vectorize binding; the reserved-actor
// rule is what these tests are about.
vi.mock("@/lib/moderation/learn", () => ({
  learnFromSuspension: vi.fn(async () => null),
  forgetSuspension: vi.fn(async () => true),
}));
vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAccountUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastActorUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { rejectAccount, silenceAccount, suspendAccount, unsuspendAccount, warnAccount } from "@/lib/moderation/actions";
import { runModerationCycle } from "@/lib/moderation/cycle";
import { POST as APPROVE } from "@/app/api/v1/admin/accounts/[id]/approve/route";
import { POST as UNSUSPEND } from "@/app/api/v1/admin/accounts/[id]/unsuspend/route";

const db = env.DB;
const BASE = "https://local.example.test";
const GUARDIAN = `${BASE}/users/guardian`;

async function seedActor(
  id: string,
  opts: { reserved?: boolean; role?: string; following?: number; emailVerified?: boolean } = {}
): Promise<string> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, reserved, following_count, email, email_verified, last_active_at)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(id, username, opts.reserved ? 0 : 1, opts.role ?? "user", opts.reserved ? 1 : 0, opts.following ?? 0, `${username}@example.com`, opts.emailVerified === false ? 0 : 1)
    .run();
  return id;
}

async function actorRow(id: string): Promise<{ suspended: number; silenced: number; role: string; reserved: number } | null> {
  return db
    .prepare("SELECT suspended, silenced, role, reserved FROM actors WHERE id = ?")
    .bind(id)
    .first<{ suspended: number; silenced: number; role: string; reserved: number }>();
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(GUARDIAN, { reserved: true, role: "admin" });
});

describe("the reserved Guardian account is untouchable", () => {
  it("refuses to suspend, silence, warn or reject it", async () => {
    const suspend = await suspendAccount(env, { actorId: GUARDIAN, reason: "prueba", source: "ai" });
    const silence = await silenceAccount(env, { actorId: GUARDIAN, reason: "prueba", source: "ai" });
    const warn = await warnAccount(env, { actorId: GUARDIAN, reason: "prueba", source: "ai" });
    const reject = await rejectAccount(env, { actorId: GUARDIAN, reason: "prueba", source: "ai" });

    expect([suspend.applied, silence.applied, warn.applied, reject.applied]).toEqual([false, false, false, false]);
    expect(await actorRow(GUARDIAN)).toMatchObject({ suspended: 0, silenced: 0, role: "admin", reserved: 1 });

    // Every refusal is auditable, with the action that was attempted.
    const rows = await db
      .prepare("SELECT details FROM moderation_log WHERE target_id = ? AND action = 'no_action'")
      .bind(GUARDIAN)
      .all<{ details: string }>();
    const attempted = rows.results.map((r) => (JSON.parse(r.details) as { attempted: string }).attempted).sort();
    expect(attempted).toEqual(["reject", "silence", "suspend", "warn"]);
  });

  it("still allows lifting a suspension from it", async () => {
    await db.prepare("UPDATE actors SET suspended = 1, suspended_at = datetime('now') WHERE id = ?").bind(GUARDIAN).run();

    const result = await unsuspendAccount(env, { actorId: GUARDIAN, reason: "corrección", source: "system" });

    expect(result.applied).toBe(true);
    expect(await actorRow(GUARDIAN)).toMatchObject({ suspended: 0 });
  });

  it("never becomes a candidate of the account patrol", async () => {
    // Both look like fresh, follow-heavy accounts: without the reserved filter
    // the Guardian would be reviewed (and the KV marker proves candidacy).
    await seedActor(`${BASE}/users/control`, { following: 60 });
    await db.prepare("UPDATE actors SET following_count = 60 WHERE id = ?").bind(GUARDIAN).run();

    await runModerationCycle(env as never);

    expect(await env.KV.get(`guardian:account:${GUARDIAN}`)).toBeNull();
    expect(await env.KV.get(`guardian:account:${BASE}/users/control`)).toBe("1");
  });

  it("refuses the admin approve action too", async () => {
    await seedActor(`${BASE}/users/admin`, { role: "admin" });
    await db
      .prepare(
        "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, 'admin-token', 'read write', datetime('now'))"
      )
      .bind(`${BASE}/users/admin`)
      .run();

    const res = await APPROVE(
      new NextRequest(`${BASE}/api/v1/admin/accounts/${encodeURIComponent(GUARDIAN)}/approve`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-token" },
      }),
      { params: Promise.resolve({ id: GUARDIAN }) }
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "The instance actor cannot be modified",
      error_code: "admin_error_reserved_account",
    });
  });

  it("lets the panel repair a suspension of the reserved account", async () => {
    await seedActor(`${BASE}/users/admin`, { role: "admin" });
    await db
      .prepare(
        "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, 'admin-token', 'read write', datetime('now'))"
      )
      .bind(`${BASE}/users/admin`)
      .run();
    await db.prepare("UPDATE actors SET suspended = 1, suspended_at = datetime('now') WHERE id = ?").bind(GUARDIAN).run();

    const res = await UNSUSPEND(
      new NextRequest(`${BASE}/api/v1/admin/accounts/${encodeURIComponent(GUARDIAN)}/unsuspend`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-token" },
      }),
      { params: Promise.resolve({ id: GUARDIAN }) }
    );

    expect(res.status).toBe(200);
    expect(await actorRow(GUARDIAN)).toMatchObject({ suspended: 0 });
  });
});
