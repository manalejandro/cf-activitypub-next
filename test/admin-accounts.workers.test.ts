import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { GET as ADMIN_ACCOUNTS } from "@/app/api/v1/admin/accounts/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "admin-token";

async function seedActor(
  id: string,
  opts: { local?: boolean; role?: string; suspended?: boolean; suspendedAt?: string | null; email?: string | null } = {}
): Promise<string> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, suspended, suspended_at, email, email_verified)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, ?, ?, ?, 1)`
    )
    .bind(
      id,
      username,
      domain,
      opts.local === false ? null : "priv",
      opts.local === false ? 0 : 1,
      opts.role ?? "user",
      opts.suspended ? 1 : 0,
      opts.suspendedAt ?? null,
      opts.email === undefined ? `${username}@example.com` : opts.email
    )
    .run();
  return id;
}

async function seedToken(actorId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(actorId, TOKEN)
    .run();
}

function list(query: string): Promise<Response> {
  return ADMIN_ACCOUNTS(
    new NextRequest(`${BASE}/api/v1/admin/accounts?${query}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  );
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  const admin = await seedActor(`${BASE}/users/admin`, { role: "admin" });
  await seedToken(admin);
});

describe("GET /api/v1/admin/accounts", () => {
  it("lists suspended local accounts, with the suspension date, under the suspended filter", async () => {
    await seedActor(`${BASE}/users/spammer`, { suspended: true, suspendedAt: "2026-09-27T23:55:07.000Z" });
    await seedActor(`${BASE}/users/alice`);

    const res = await list("status=suspended&local=true&limit=50&page=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accounts: { username: string; suspended: boolean; suspended_at: string | null }[]; total: number };

    expect(body.accounts.map((a) => a.username)).toEqual(["spammer"]);
    expect(body.accounts[0].suspended).toBe(true);
    expect(body.accounts[0].suspended_at).toBe("2026-09-27T23:55:07.000Z");
    expect(body.total).toBe(1);
  });

  it("keeps suspended accounts out of the unfiltered table (they have their own)", async () => {
    await seedActor(`${BASE}/users/spammer`, { suspended: true, suspendedAt: "2026-09-27T23:55:07.000Z" });
    await seedActor(`${BASE}/users/alice`);

    const res = await list("local=true&limit=50&page=1");
    const body = (await res.json()) as { accounts: { username: string }[]; total: number };

    const usernames = body.accounts.map((a) => a.username);
    expect(usernames).toContain("alice");
    expect(usernames).not.toContain("spammer");
  });

  it("keeps suspended accounts out of the other status filters too", async () => {
    await seedActor(`${BASE}/users/spammer`, { suspended: true, suspendedAt: "2026-09-27T23:55:07.000Z" });

    const res = await list("status=silenced&local=true&limit=50&page=1");
    const body = (await res.json()) as { accounts: { username: string }[]; total: number };
    expect(body.accounts.map((a) => a.username)).not.toContain("spammer");
  });

  it("exposes the email so the table can show it under the username", async () => {
    await seedActor(`${BASE}/users/alice`, { email: "alice@example.com" });

    const res = await list("local=true&limit=50&page=1");
    const body = (await res.json()) as { accounts: { username: string; email: string | null }[] };

    expect(body.accounts.find((a) => a.username === "alice")?.email).toBe("alice@example.com");
  });
});
