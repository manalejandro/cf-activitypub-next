import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { resolveLimits } from "@/lib/constants";
import { POST as MEDIA_V1 } from "@/app/api/v1/media/route";
import { POST as MEDIA_V2 } from "@/app/api/v2/media/route";

const db = env.DB;
// Derived from the effective limits (env vars may override the defaults): the
// route's early gate is `max(per-type caps) + 1 MB`, so anything past that
// must 413 whatever the configuration says.
const limits = resolveLimits(env as unknown as Record<string, unknown>);
const OVERSIZED = Math.max(limits.maxImageSize, limits.maxVideoSize, limits.maxDocumentSize) + 2 * 1024 * 1024;
const BASE = "https://local.example.test";
const ALICE = `${BASE}/users/alice`;
const TOKEN = "upload-token";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified)
       VALUES (?, 'alice', 'local.example.test', 'pub', 'priv', 1, 'alice@example.com', 1)`
    )
    .bind(ALICE)
    .run();
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(ALICE, TOKEN)
    .run();
});

function uploadRequest(init: { body: BodyInit | null; headers?: Record<string, string> }): NextRequest {
  return new NextRequest(`${BASE}/api/v1/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
    body: init.body,
  });
}

describe("media upload guards", () => {
  it("rejects an oversized body by Content-Length before parsing it (v1)", async () => {
    const res = await MEDIA_V1(
      uploadRequest({
        body: null,
        headers: {
          "Content-Type": "multipart/form-data; boundary=x",
          "Content-Length": String(OVERSIZED),
        },
      })
    );
    expect(res.status).toBe(413);
  });

  it("sanitises a traversal file name out of the R2 key (v2)", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "../../evil.php", { type: "image/png" }));
    const res = await MEDIA_V2(
      new NextRequest(`${BASE}/api/v2/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: form,
      })
    );
    expect(res.status).toBe(200);

    const listed = await env.R2.list();
    expect(listed.objects).toHaveLength(1);
    const key = listed.objects[0].key;
    expect(key).toMatch(/^media\/alice\/[0-9a-f-]{36}-evil\.php$/);
    expect(key).not.toContain("..");
  });

  it("keeps a well-formed upload working end to end (v2)", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "foto de playa.png", { type: "image/png" }));
    form.append("description", "Una playa");
    const res = await MEDIA_V2(
      new NextRequest(`${BASE}/api/v2/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: form,
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; description: string | null };
    expect(body.url).toContain("/api/media/media/alice/");
    expect(body.url).toContain("foto_de_playa.png");
    expect(body.description).toBe("Una playa");

    const listed = await env.R2.list();
    expect(listed.objects).toHaveLength(1);
  });

  it("rejects an upload that would exceed the account's storage quota (v2)", async () => {
    // Seed an attachment whose recorded size is already above the default
    // 5 GiB quota (the test env does not override UPLOAD_QUOTA_BYTES).
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
         VALUES (?, 'Note', ?, '<p>x</p>', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
      )
      .bind(`${BASE}/objects/big-1`, ALICE)
      .run();
    await db
      .prepare("INSERT INTO attachments (id, object_id, type, url, file_size) VALUES ('big', ?, 'video', 'https://x/v.mp4', 6000000000)")
      .bind(`${BASE}/objects/big-1`)
      .run();

    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "otra.png", { type: "image/png" }));
    const res = await MEDIA_V2(
      new NextRequest(`${BASE}/api/v2/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: form,
      })
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error_code?: string };
    expect(body.error_code).toBe("media_error_quota");
  });
});
