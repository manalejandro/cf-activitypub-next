import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";
import { POST } from "@/app/api/v1/push/subscription/route";
import { deliverPushNotification } from "@/lib/push";

const db = env.DB;
const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;
const TOKEN = "push-token";

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
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write push', datetime('now'))"
    )
    .bind(ALICE, TOKEN)
    .run();
});

function postSubscription(endpoint: string): Promise<Response> {
  return POST(
    new NextRequest(`${BASE}/api/v1/push/subscription`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: { endpoint, keys: { p256dh: "a-key", auth: "b-key" } },
        data: { alerts: { mention: true } },
      }),
    })
  );
}

describe("push subscription endpoint validation (SSRF)", () => {
  it("rejects a plain-http internal endpoint", async () => {
    const res = await postSubscription("http://127.0.0.1:8080/x");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error_code?: string };
    expect(body.error_code).toBe("push_error_endpoint");
  });

  it("rejects the cloud metadata address even over https", async () => {
    const res = await postSubscription("https://169.254.169.254/latest/meta-data/");
    expect(res.status).toBe(422);
  });

  it("accepts a normal https push-service endpoint", async () => {
    const res = await postSubscription("https://push.example.com/fcm/abc123");
    expect(res.status).toBe(200);
    const row = await db
      .prepare("SELECT endpoint FROM push_subscriptions WHERE actor_id = ?")
      .bind(ALICE)
      .first<{ endpoint: string }>();
    expect(row?.endpoint).toBe("https://push.example.com/fcm/abc123");
  });
});

describe("push delivery guard", () => {
  it("refuses a legacy non-HTTPS endpoint before any crypto or fetch", async () => {
    await db
      .prepare(
        "INSERT INTO push_subscriptions (id, actor_id, endpoint, p256dh_key, auth_key, alerts, policy) VALUES ('ps1', ?, 'http://internal.example/push', 'k', 'k', '{}', 'all')"
      )
      .bind(ALICE)
      .run();
    // Garbage VAPID keys: if the early guard regresses, the crypto path throws.
    await expect(
      deliverPushNotification(db, "pub", "not-a-key", "mailto:a@b.c", {
        id: "n1",
        type: "mention",
        accountId: ALICE,
        targetAccountId: ALICE,
      } as never)
    ).resolves.toBeUndefined();
  });
});
