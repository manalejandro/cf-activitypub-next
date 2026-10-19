import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

// The suspend route federates the actor document: the delivery fan-out is not
// what these tests are about (the queue and the followers are empty anyway).
vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAccountUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastActorUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { DELETE as DELETE_ACCOUNT } from "@/app/api/v1/admin/accounts/[id]/route";
import { POST as SUSPEND } from "@/app/api/v1/admin/accounts/[id]/suspend/route";

const db = env.DB;
const BASE = "https://local.example.test";

async function seedActor(
  id: string,
  opts: { role?: string; reserved?: boolean } = {}
): Promise<string> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, reserved, email, email_verified)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, 1, ?, ?, ?, 1)`
    )
    .bind(id, username, opts.role ?? "user", opts.reserved ? 1 : 0, `${username}@example.com`)
    .run();
  return id;
}

async function seedToken(actorId: string, token: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(`t-${token}`, actorId, token)
    .run();
}

function call(handler: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, method: string, id: string, token: string): Promise<Response> {
  return handler(
    new NextRequest(`${BASE}/api/v1/admin/accounts/${encodeURIComponent(id)}${method === "DELETE" ? "" : "/suspend"}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(`${BASE}/users/admin`, { role: "admin" });
  await seedToken(`${BASE}/users/admin`, "admin-token");
  await seedActor(`${BASE}/users/mod`, { role: "moderator" });
  await seedToken(`${BASE}/users/mod`, "mod-token");
  await seedActor(`${BASE}/users/regular`);
});

describe("DELETE /api/v1/admin/accounts/:id", () => {
  it("refuses a moderator: suspension is the strongest action they have", async () => {
    const res = await call(DELETE_ACCOUNT, "DELETE", `${BASE}/users/regular`, "mod-token");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Administrator role required",
      error_code: "admin_account_delete_admin_only",
    });
    // Nothing happened: the account is still there, with no deletion logged.
    const row = await db.prepare("SELECT id FROM actors WHERE id = ?").bind(`${BASE}/users/regular`).first<{ id: string }>();
    expect(row?.id).toBe(`${BASE}/users/regular`);
    const log = await db.prepare("SELECT COUNT(*) AS n FROM moderation_log WHERE action = 'deleted'").first<{ n: number }>();
    expect(log?.n).toBe(0);

    // The same moderator can still suspend the account.
    const suspended = await call(SUSPEND, "POST", `${BASE}/users/regular`, "mod-token");
    expect(suspended.status).toBe(200);
    const after = await db
      .prepare("SELECT suspended FROM actors WHERE id = ?")
      .bind(`${BASE}/users/regular`)
      .first<{ suspended: number }>();
    expect(after?.suspended).toBe(1);
  });

  it("lets an administrator delete the account", async () => {
    const res = await call(DELETE_ACCOUNT, "DELETE", `${BASE}/users/regular`, "admin-token");
    expect(res.status).toBe(200);
    expect(await db.prepare("SELECT id FROM actors WHERE id = ?").bind(`${BASE}/users/regular`).first()).toBeNull();
    const log = await db
      .prepare("SELECT action, target_id FROM moderation_log WHERE target_id = ? ORDER BY created_at DESC")
      .bind(`${BASE}/users/regular`)
      .first<{ action: string; target_id: string }>();
    expect(log).toEqual({ action: "deleted", target_id: `${BASE}/users/regular` });
  });

  it("still blocks self-deletion and the reserved instance actor", async () => {
    const self = await call(DELETE_ACCOUNT, "DELETE", `${BASE}/users/admin`, "admin-token");
    expect(self.status).toBe(422);

    await seedActor(`${BASE}/actor`, { reserved: true });
    const reserved = await call(DELETE_ACCOUNT, "DELETE", `${BASE}/actor`, "admin-token");
    expect(reserved.status).toBe(422);
    expect(await db.prepare("SELECT id FROM actors WHERE id = ?").bind(`${BASE}/actor`).first()).not.toBeNull();
  });
});
