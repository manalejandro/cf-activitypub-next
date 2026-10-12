import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

vi.mock("@/lib/moderation/pipeline", () => ({
  screenStatus: vi.fn().mockResolvedValue({ blocked: false, markedSensitive: false }),
}));
vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusCreatedToAudience: vi.fn().mockResolvedValue(undefined),
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
}));
vi.mock("@/lib/push", () => ({ deliverPushSafe: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/activitypub/queue", () => ({
  enqueueDeliveries: vi.fn().mockResolvedValue(undefined),
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/activitypub/federation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/federation")>()),
  collectFollowerInboxes: vi.fn().mockResolvedValue([]),
}));

import { POST } from "@/app/api/v1/statuses/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "compose-token";
const MEDIA_ID = "media-1";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified, discoverable)
       VALUES (?, 'me', 'local.example.test', 'pub', 'priv', 1, 'me@example.com', 1, 1)`
    )
    .bind(`${BASE}/users/me`)
    .run();
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(`${BASE}/users/me`, TOKEN)
    .run();
  // What POST /api/v1/media leaves behind for the status to pick up.
  await env.KV.put(
    `pending_media:${MEDIA_ID}`,
    JSON.stringify({
      id: MEDIA_ID,
      objectId: null,
      type: "image",
      url: `${BASE}/api/media/media/me/photo.png`,
      remoteUrl: null,
      description: "una foto",
      sensitive: false,
      createdAt: new Date().toISOString(),
      actorId: `${BASE}/users/me`,
    }),
    { expirationTtl: 3600 }
  );
});

function post(body: BodyInit, contentType: string): NextRequest {
  return new NextRequest(`${BASE}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": contentType },
    body,
  });
}

describe("POST /api/v1/statuses with media", () => {
  it("attaches media sent as a form-encoded `media_ids[]` (Tusky)", async () => {
    const res = await POST(post(`status=hola&media_ids%5B%5D=${MEDIA_ID}`, "application/x-www-form-urlencoded"));

    expect(res.status).toBe(200);
    const status = (await res.json()) as { content: string; media_attachments: { id: string; description: string }[] };
    expect(status.media_attachments).toHaveLength(1);
    expect(status.media_attachments[0].id).toBe(MEDIA_ID);
    expect(status.media_attachments[0].description).toBe("una foto");

    // The pending upload is consumed and linked to the stored object.
    const attachment = await db
      .prepare("SELECT object_id FROM attachments WHERE id = ?")
      .bind(MEDIA_ID)
      .first<{ object_id: string }>();
    expect(attachment?.object_id).toBeTruthy();
    expect(await env.KV.get(`pending_media:${MEDIA_ID}`)).toBeNull();
  });

  it("attaches media sent as a JSON array", async () => {
    const res = await POST(post(JSON.stringify({ status: "hola", media_ids: [MEDIA_ID] }), "application/json"));

    expect(res.status).toBe(200);
    const status = (await res.json()) as { media_attachments: { id: string }[] };
    expect(status.media_attachments.map((a) => a.id)).toEqual([MEDIA_ID]);
  });

  it("accepts a single media id without the array brackets", async () => {
    const res = await POST(post(`status=hola&media_ids=${MEDIA_ID}`, "application/x-www-form-urlencoded"));

    expect(res.status).toBe(200);
    const status = (await res.json()) as { media_attachments: { id: string }[] };
    expect(status.media_attachments.map((a) => a.id)).toEqual([MEDIA_ID]);
  });
});
