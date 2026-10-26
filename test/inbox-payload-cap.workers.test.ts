import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

// The route-level flow after the cap is signature verification; stub it so the
// tests never touch the network. The cap itself must fire BEFORE any of it.
vi.mock("@/lib/activitypub/signer-key", () => ({
  verifyIncomingSignature: vi.fn().mockResolvedValue({ ok: false, reason: "invalid" }),
  purgeGoneSignerData: vi.fn().mockResolvedValue(false),
}));

import { POST as SHARED_INBOX } from "@/app/api/inbox/route";
import { POST as USER_INBOX } from "@/app/api/users/[username]/inbox/route";

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
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, 'alice', 'local.example.test', 'pub', 'priv', 1)`
    )
    .bind(ALICE)
    .run();
});

function post(
  handler: typeof SHARED_INBOX,
  url: string,
  init: { headers?: Record<string, string>; body?: BodyInit | null }
): Promise<Response> {
  return handler(new NextRequest(url, { method: "POST", headers: init.headers, body: init.body }));
}

describe("inbox payload cap", () => {
  it("rejects an oversized declared Content-Length without reading the body", async () => {
    const res = await post(SHARED_INBOX, `${BASE}/inbox`, {
      headers: { "Content-Type": "application/activity+json", "Content-Length": String(5_000_000) },
      body: null,
    });
    expect(res.status).toBe(413);
  });

  it("rejects an oversized streamed body even when the declared length lies", async () => {
    const huge = `{"actor":"https://remote.example/users/x","type":"Create","junk":"${"a".repeat(1_200_000)}"}`;
    const res = await post(SHARED_INBOX, `${BASE}/inbox`, {
      headers: { "Content-Type": "application/activity+json", "Content-Length": "10" },
      body: huge,
    });
    expect(res.status).toBe(413);
  });

  it("still reads a near-cap body and fails on its JSON, not on the cap", async () => {
    const res = await post(SHARED_INBOX, `${BASE}/inbox`, {
      headers: { "Content-Type": "application/activity+json" },
      body: "x".repeat(999_000),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized body on the per-user inbox too", async () => {
    const huge = `{"actor":"https://remote.example/users/x","type":"Create","junk":"${"a".repeat(1_200_000)}"}`;
    const res = await USER_INBOX(
      new NextRequest(`${BASE}/users/alice/inbox`, {
        method: "POST",
        headers: { "Content-Type": "application/activity+json" },
        body: huge,
      }),
      { params: Promise.resolve({ username: "alice" }) }
    );
    expect(res.status).toBe(413);
  });

  it("lets a normal-sized activity reach signature verification (401, not 413)", async () => {
    const res = await post(SHARED_INBOX, `${BASE}/inbox`, {
      headers: { "Content-Type": "application/activity+json" },
      body: JSON.stringify({ actor: "https://remote.example/users/x", type: "Create", object: "https://remote.example/o/1" }),
    });
    expect(res.status).toBe(401);
  });
});
