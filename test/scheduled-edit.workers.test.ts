import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { createScheduledStatus } from "@/lib/db";
import { GET, PUT } from "@/app/api/v1/scheduled_statuses/[id]/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "test-token-sched";
const ME = `${BASE}/users/me`;
const OTHER = `${BASE}/users/other`;

async function seedLocal(id: string, username: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, ?, 1)`
    )
    .bind(id, username, `${username}@example.com`)
    .run();
}

async function seedToken(actorId: string): Promise<void> {
  await db
    .prepare("INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t-sched', ?, NULL, ?, 'read write', datetime('now'))")
    .bind(actorId, TOKEN)
    .run();
}

function request(id: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`${BASE}/api/v1/scheduled_statuses/${id}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const future = () => new Date(Date.now() + 3600_000).toISOString();

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedLocal(ME, "me");
  await seedLocal(OTHER, "other");
  await seedToken(ME);
});

describe("editing a scheduled status (PUT /api/v1/scheduled_statuses/:id)", () => {
  it("updates the publish instant and the stored params", async () => {
    await createScheduledStatus(db, "s1", ME, "2030-01-01 00:00:00", JSON.stringify({ status: "hola", visibility: "public" }), null);

    const res = await PUT(request("s1", "PUT", { status: "adiós", visibility: "unlisted", scheduled_at: future() }), ctx("s1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { params: { status: string; visibility: string }; scheduled_at: string };
    expect(body.params.status).toBe("adiós");
    expect(body.params.visibility).toBe("unlisted");

    const row = await db
      .prepare("SELECT scheduled_at, params FROM scheduled_statuses WHERE id = 's1'")
      .first<{ scheduled_at: string; params: string }>();
    expect(row?.params).toContain("adiós");
    // The column keeps datetime('now')'s shape (the cron compares against it).
    expect(row?.scheduled_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("keeps the stored instant when scheduled_at is omitted", async () => {
    await createScheduledStatus(db, "s2", ME, "2030-01-01 10:00:00", JSON.stringify({ status: "x" }), null);

    const res = await PUT(request("s2", "PUT", { status: "y" }), ctx("s2"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scheduled_at: string };
    expect(body.scheduled_at).toBe("2030-01-01T10:00:00.000Z");
  });

  it("rejects a past instant", async () => {
    await createScheduledStatus(db, "s3", ME, "2030-01-01 00:00:00", "{}", null);

    const res = await PUT(
      request("s3", "PUT", { status: "x", scheduled_at: new Date(Date.now() - 60_000).toISOString() }),
      ctx("s3")
    );
    expect(res.status).toBe(422);
  });

  it("is a 404 for somebody else's schedule", async () => {
    await createScheduledStatus(db, "s4", OTHER, "2030-01-01 00:00:00", "{}", null);

    const res = await PUT(request("s4", "PUT", { status: "x" }), ctx("s4"));
    expect(res.status).toBe(404);
    const get = await GET(request("s4", "GET"), ctx("s4"));
    expect(get.status).toBe(404);
  });

  it("drops foreign media ids and serves the reserved uploads in GET", async () => {
    await env.KV.put(
      "pending_media:m-mine",
      JSON.stringify({ actorId: ME, type: "image", url: `${BASE}/api/media/media/me/x.png`, fileSize: 10 })
    );
    await env.KV.put(
      "pending_media:m-theirs",
      JSON.stringify({ actorId: OTHER, type: "image", url: `${BASE}/api/media/media/other/y.png` })
    );
    await createScheduledStatus(db, "s5", ME, "2030-01-01 00:00:00", JSON.stringify({ status: "con media" }), null);

    const res = await PUT(request("s5", "PUT", { status: "con media", media_ids: ["m-mine", "m-theirs"] }), ctx("s5"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { media_attachments: { id: string; url: string }[] };
    expect(body.media_attachments.map((m) => m.id)).toEqual(["m-mine"]);

    // The reservation of an edited schedule survives with an extended TTL, and
    // the media_ids column only kept the owned one.
    const row = await db.prepare("SELECT media_ids FROM scheduled_statuses WHERE id = 's5'").first<{ media_ids: string | null }>();
    expect(row?.media_ids).toBe(JSON.stringify(["m-mine"]));
    expect(await env.KV.get("pending_media:m-mine")).not.toBeNull();
    const ttl = await env.KV.getWithMetadata("pending_media:m-mine");
    expect(ttl).toBeTruthy();

    const get = await GET(request("s5", "GET"), ctx("s5"));
    const getBody = (await get.json()) as { media_attachments: { id: string; url: string; type: string }[] };
    expect(getBody.media_attachments.length).toBe(1);
    expect(getBody.media_attachments[0].url).toContain("x.png");
    expect(getBody.media_attachments[0].type).toBe("image");
  });
});
