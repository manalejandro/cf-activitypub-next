import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { GET as NOTIFICATIONS } from "@/app/api/v1/notifications/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "notif-token";

async function seedActor(id: string): Promise<void> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, email, email_verified)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, 1, 'user', ?, 1)`
    )
    .bind(id, username, `${username}@example.com`)
    .run();
}

async function seedToken(actorId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(actorId, TOKEN)
    .run();
}

async function seedNotification(
  id: string,
  type: string,
  from: string,
  to: string,
  createdAt: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO notifications (id, type, account_id, target_account_id, object_id, is_read, created_at) VALUES (?, ?, ?, ?, NULL, 0, ?)"
    )
    .bind(id, type, from, to, createdAt)
    .run();
}

function list(query: string): Promise<Response> {
  return NOTIFICATIONS(
    new NextRequest(`${BASE}/api/v1/notifications?${query}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
  );
}

let me = "";
let other = "";

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  me = `${BASE}/users/me`;
  other = `${BASE}/users/other`;
  await seedActor(me);
  await seedActor(other);
  await seedToken(me);
});

/** Newer favourites interleaved with older mentions. */
async function seedMixed(): Promise<void> {
  await seedNotification("n1", "favourite", other, me, "2026-10-01T10:00:00Z");
  await seedNotification("n2", "mention", other, me, "2026-10-01T09:00:00Z");
  await seedNotification("n3", "favourite", other, me, "2026-10-01T08:00:00Z");
  await seedNotification("n4", "mention", other, me, "2026-10-01T07:00:00Z");
  await seedNotification("n5", "mention", other, me, "2026-10-01T06:00:00Z");
}

describe("GET /api/v1/notifications", () => {
  it("filters types[] in SQL, so a page holds a full page of matches", async () => {
    await seedMixed();

    const res = await list("types[]=mention&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; type: string }[];

    // The old route fetched `limit` rows and filtered them afterwards, so this
    // returned only n2 (the mentions that happened to be inside the page).
    expect(body.map((n) => n.id)).toEqual(["n2", "n4"]);
    expect(body.every((n) => n.type === "mention")).toBe(true);
  });

  it("paginates the filtered stream with max_id", async () => {
    await seedMixed();

    const res = await list("types[]=mention&limit=2&max_id=n4");
    const body = (await res.json()) as { id: string }[];
    expect(body.map((n) => n.id)).toEqual(["n5"]);
  });

  it("takes repeated types[] values (the mentions tab's mention + direct + encrypted)", async () => {
    await seedMixed();
    await seedNotification("n6", "direct", other, me, "2026-10-01T05:00:00Z");
    await seedNotification("n7", "encrypted", other, me, "2026-10-01T04:00:00Z");

    const res = await list("types[]=mention&types[]=direct&types[]=encrypted&limit=10");
    const body = (await res.json()) as { id: string }[];
    expect(body.map((n) => n.id)).toEqual(["n2", "n4", "n5", "n6", "n7"]);
  });

  it("honours exclude_types[]", async () => {
    await seedMixed();

    const res = await list("exclude_types[]=favourite&limit=10");
    const body = (await res.json()) as { id: string; type: string }[];
    expect(body.map((n) => n.id)).toEqual(["n2", "n4", "n5"]);
  });

  it("returns nothing for an unknown type instead of ignoring the filter", async () => {
    await seedMixed();

    const res = await list("types[]=bogus&limit=10");
    const body = (await res.json()) as { id: string }[];
    expect(body).toEqual([]);
  });

  it("keeps the unfiltered feed intact", async () => {
    await seedMixed();

    const res = await list("limit=10");
    const body = (await res.json()) as { id: string }[];
    expect(body.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
  });
});
