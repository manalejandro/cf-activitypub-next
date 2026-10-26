import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";
import { POST as ROTATE } from "@/app/api/auth/rotate/route";

const db = env.DB;
const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified)
       VALUES (?, 'alice', 'local.example.test', 'pub', 'priv', 1, 'a@example.com', 1)`
    )
    .bind(ALICE)
    .run();
});

async function seedToken(token: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write follow push', datetime('now'))"
    )
    .bind(`tok-${token}`, ALICE, token)
    .run();
}

function rotateWith(headers: Record<string, string>): Promise<Response> {
  return ROTATE(new NextRequest(`${BASE}/api/auth/rotate`, { method: "POST", headers }));
}

describe("POST /api/auth/rotate", () => {
  it("refuses an unauthenticated caller", async () => {
    const res = await rotateWith({});
    expect(res.status).toBe(401);
  });

  it("exchanges a cookie session for a fresh HttpOnly cookie + body token", async () => {
    await seedToken("old-token");
    const res = await rotateWith({ Cookie: "auth_token=old-token" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).toBeTruthy();
    expect(body.access_token).not.toBe("old-token");

    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain(`auth_token=${body.access_token}`);

    // The presented token is retired; the new one is stored.
    const old = await db.prepare("SELECT id FROM oauth_tokens WHERE access_token = 'old-token'").first();
    expect(old).toBeNull();
    const fresh = await db
      .prepare("SELECT actor_id FROM oauth_tokens WHERE access_token = ?")
      .bind(body.access_token)
      .first<{ actor_id: string }>();
    expect(fresh?.actor_id).toBe(ALICE);
  });

  it("works with a Bearer token too", async () => {
    await seedToken("bearer-token");
    const res = await rotateWith({ Authorization: "Bearer bearer-token" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).not.toBe("bearer-token");
  });
});
