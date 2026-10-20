import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const mocks = vi.hoisted(() => ({ enqueueDeliveries: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/activitypub/queue", () => ({ enqueueDeliveries: mocks.enqueueDeliveries }));

import { POST as PIN } from "@/app/api/v1/statuses/[id]/pin/route";
import { POST as UNPIN } from "@/app/api/v1/statuses/[id]/unpin/route";
import { POST as FEATURE_TAG } from "@/app/api/v1/featured_tags/route";
import { DELETE as UNFEATURE_TAG } from "@/app/api/v1/featured_tags/[id]/route";
import { POST as ENDORSE } from "@/app/api/v1/accounts/[id]/pin/route";
import { GET as FEATURED_COLLECTION } from "@/app/users/[username]/collections/featured/route";
import { GET as TAGS_COLLECTION } from "@/app/users/[username]/collections/tags/route";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const ME = `${BASE}/users/me`;
const FAN = "https://remote.example/users/fan";
const FAN_INBOX = "https://remote.example/inbox";
const OTHER = `${BASE}/users/other`;
const STATUS_UUID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const STATUS = `${BASE}/objects/${STATUS_UUID}`;
const TOKEN = "featured-token";

async function seed(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified)
       VALUES (?, 'me', ?, 'pub', 'priv', 1, 1, 'me@example.com', 1),
              (?, 'other', ?, 'pub', 'priv', 1, 1, 'other@example.com', 1),
              (?, 'fan', 'remote.example', 'pub', NULL, 0, 1, 'fan@remote.example', 1)`
    )
    .bind(ME, new URL(ME).hostname, OTHER, new URL(OTHER).hostname, FAN)
    .run();
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at)
       VALUES ('t-feat', ?, NULL, ?, 'read write', datetime('now'))`
    )
    .bind(ME, TOKEN)
    .run();
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, '<p>hola</p>', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
    )
    .bind(STATUS, ME)
    .run();
  await db
    .prepare("UPDATE actors SET inbox = ?, shared_inbox = ? WHERE id = ?")
    .bind(FAN_INBOX, FAN_INBOX, FAN)
    .run();
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
    .bind(FAN, ME)
    .run();
}

function call(handler: typeof PIN, path: string, id: string): Promise<Response> {
  return handler(
    new NextRequest(`${BASE}${path}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }),
    { params: Promise.resolve({ id }) }
  );
}

function lastActivity(): { type: string; actor: string; object: unknown; target: string } {
  const call = mocks.enqueueDeliveries.mock.calls.at(-1) as [unknown, string[], string] | undefined;
  expect(call).toBeTruthy();
  expect(call![1]).toEqual([FAN_INBOX]);
  return JSON.parse(call![2]) as { type: string; actor: string; object: unknown; target: string };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  mocks.enqueueDeliveries.mockClear();
  await seed();
});

describe("featured items on a profile", () => {
  it("federates a pinned status with Add/Remove and serves the featured collection", async () => {
    const pinned = await call(PIN, `/api/v1/statuses/${STATUS_UUID}/pin`, STATUS_UUID);
    expect(pinned.status).toBe(200);

    // Mastodon's AddSerializer: type/actor/object (the status IRI)/target (the
    // featured collection), delivered to the followers through the queue.
    expect(lastActivity()).toMatchObject({
      type: "Add",
      actor: ME,
      object: STATUS,
      target: `${ME}/collections/featured`,
    });

    const collection = await FEATURED_COLLECTION(
      new NextRequest(`${BASE}/users/me/collections/featured`),
      { params: Promise.resolve({ username: "me" }) }
    );
    expect(collection.status).toBe(200);
    expect(collection.headers.get("Content-Type")).toContain("activity+json");
    const body = (await collection.json()) as { type: string; totalItems: number; orderedItems: string[] };
    expect(body).toMatchObject({ type: "OrderedCollection", totalItems: 1, orderedItems: [STATUS] });

    await call(UNPIN, `/api/v1/statuses/${STATUS_UUID}/unpin`, STATUS_UUID);
    expect(lastActivity()).toMatchObject({ type: "Remove", object: STATUS, target: `${ME}/collections/featured` });

    const after = (await (await FEATURED_COLLECTION(
      new NextRequest(`${BASE}/users/me/collections/featured`),
      { params: Promise.resolve({ username: "me" }) }
    )).json()) as { totalItems: number };
    expect(after.totalItems).toBe(0);
  });

  it("federates a featured hashtag and serves the tags collection", async () => {
    const created = await FEATURE_TAG(
      new NextRequest(`${BASE}/api/v1/featured_tags`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "#ActivityPub" }),
      })
    );
    expect(created.status).toBe(200);
    const tag = (await created.json()) as { id: string; name: string };
    expect(tag.name).toBe("activitypub");

    // Mastodon's HashtagSerializer is the object of the Add.
    expect(lastActivity()).toMatchObject({
      type: "Add",
      object: { type: "Hashtag", href: `${BASE}/tags/activitypub`, name: "#activitypub" },
      target: `${ME}/collections/tags`,
    });

    const collection = await TAGS_COLLECTION(
      new NextRequest(`${BASE}/users/me/collections/tags`),
      { params: Promise.resolve({ username: "me" }) }
    );
    const body = (await collection.json()) as { type: string; totalItems: number; items: unknown[] };
    expect(body).toMatchObject({ type: "Collection", totalItems: 1 });
    expect(body.items[0]).toEqual({ type: "Hashtag", href: `${BASE}/tags/activitypub`, name: "#activitypub" });

    await UNFEATURE_TAG(
      new NextRequest(`${BASE}/api/v1/featured_tags/${tag.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      { params: Promise.resolve({ id: tag.id }) }
    );
    expect(lastActivity()).toMatchObject({ type: "Remove", target: `${ME}/collections/tags` });
  });

  it("keeps the profile recommendation local but requires a follow", async () => {
    // Not following: Mastodon's AccountPin validation refuses it.
    const refused = await call(ENDORSE, `/api/v1/accounts/${encodeURIComponent(OTHER)}/pin`, OTHER);
    expect(refused.status).toBe(422);

    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f2', ?, ?, 'accepted')")
      .bind(ME, OTHER)
      .run();
    const accepted = await call(ENDORSE, `/api/v1/accounts/${encodeURIComponent(OTHER)}/pin`, OTHER);
    expect(accepted.status).toBe(200);

    // Recommending an account never federates (Mastodon's AccountPin is local).
    expect(mocks.enqueueDeliveries).not.toHaveBeenCalled();
  });

  it("serves nothing for a suspended account", async () => {
    await call(PIN, `/api/v1/statuses/${STATUS_UUID}/pin`, STATUS_UUID);
    await db.prepare("UPDATE actors SET suspended = 1 WHERE id = ?").bind(ME).run();

    for (const handler of [FEATURED_COLLECTION, TAGS_COLLECTION]) {
      const res = await handler(new NextRequest(`${BASE}/users/me/collections/x`), {
        params: Promise.resolve({ username: "me" }),
      });
      expect(res.status).toBe(404);
    }
  });
});
