import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/auth/status/route";
import { installTestContext } from "./helpers/context";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

const BASE = "https://local.example.test";
const ACTOR = `${BASE}/users/manalejandro`;
const TOKEN = "session-token";

beforeAll(async () => {
  installTestContext();
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  await env.DB
    .prepare(
      "INSERT INTO actors (id, username, domain, public_key_pem, is_local, email, email_verified) VALUES (?,?,?,'k',1,?,1)"
    )
    .bind(ACTOR, "manalejandro", "local.example.test", "manalejandro@example.com")
    .run();
  await env.DB
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, access_token, refresh_token, scope, expires_at, created_at) VALUES ('t1', ?, ?, 'r1', 'read write', '2099-01-01T00:00:00Z', datetime('now'))"
    )
    .bind(ACTOR, TOKEN)
    .run();
});

function statusRequest(token?: string): Request {
  return new Request(`${BASE}/api/auth/status`, {
    headers: token ? { Cookie: `auth_token=${token}` } : {},
  });
}

describe("GET /api/auth/status", () => {
  it("reports a valid session", async () => {
    const res = await GET(statusRequest(TOKEN) as never);
    const body = await res.json() as { authenticated: boolean; actor?: { id: string } };
    expect(body.authenticated).toBe(true);
    expect(body.actor?.id).toBe(ACTOR);
  });

  it("flags a suspended account so the client lands on the public page", async () => {
    await env.DB.prepare("UPDATE actors SET suspended = 1 WHERE id = ?").bind(ACTOR).run();
    const res = await GET(statusRequest(TOKEN) as never);
    expect(await res.json()).toMatchObject({ authenticated: false, reason: "suspended" });
  });

  it("flags a deleted actor (token row left behind)", async () => {
    await env.DB.prepare("DELETE FROM actors WHERE id = ?").bind(ACTOR).run();
    const res = await GET(statusRequest(TOKEN) as never);
    expect(await res.json()).toMatchObject({ authenticated: false, reason: "deleted" });
  });

  it("flags an unknown token as invalid", async () => {
    const res = await GET(statusRequest("nope") as never);
    expect(await res.json()).toMatchObject({ authenticated: false, reason: "invalid" });
  });

  it("returns plain unauthenticated without a token", async () => {
    const res = await GET(statusRequest() as never);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("keeps silenced (limited) accounts signed in", async () => {
    await env.DB.prepare("UPDATE actors SET silenced = 1 WHERE id = ?").bind(ACTOR).run();
    const res = await GET(statusRequest(TOKEN) as never);
    expect(await res.json()).toMatchObject({ authenticated: true });
  });
});
