import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getFollowers } from "@/app/api/v1/accounts/[id]/followers/route";
import { GET as getFollowing } from "@/app/api/v1/accounts/[id]/following/route";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

/**
 * Follow/following lists must carry the account bio rendered with custom
 * emojis (the profile's own bio already did): the routes pass the emoji
 * catalogue to `serializeAccount`, which linkifies `:shortcode:` into the
 * emoji <img> and reports the used emojis in `account.emojis`.
 */
beforeAll(async () => {
  await applyTestSchema();
});

const db = env.DB;
const BASE = "https://local.example.test";
const OWNER = `${BASE}/users/owner`;
const FRIEND = "https://remote.example/users/friend";
const EMOJI_URL = `${BASE}/emoji/party.png`;

async function insertActor(id: string, isLocal: 0 | 1, displayName: string | null = null, summary: string | null = null) {
  const url = new URL(id);
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, display_name, summary, public_key_pem, is_local)
       VALUES (?,?,?,?,?,'k',?)`
    )
    .bind(id, url.pathname.split("/").pop(), url.hostname, displayName, summary, isLocal)
    .run();
}

async function follow(actorId: string, targetId: string) {
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?,?,?,'accepted')")
    .bind(`${actorId}->${targetId}`, actorId, targetId)
    .run();
}

function routeRequest(path: string) {
  const url = new URL(path, BASE);
  // The handlers only read `nextUrl.searchParams` and `url`.
  return { nextUrl: url, url: url.toString() } as never;
}

function params(id: string) {
  return { params: Promise.resolve({ id: encodeURIComponent(id) }) } as never;
}

beforeEach(async () => {
  await resetTestDatabase();
  await insertActor(OWNER, 1);
  await insertActor(FRIEND, 0, "Amiga :party:", "<p>Hola :party: mundo</p>");
  await db
    .prepare(
      `INSERT INTO custom_emojis (id, shortcode, url, static_url, domain, visible_in_picker)
       VALUES ('e1', 'party', ?, ?, NULL, 1)`
    )
    .bind(EMOJI_URL, EMOJI_URL)
    .run();
});

describe("account follow lists (Workers runtime)", () => {
  it("renders the bio with custom emojis in the following list", async () => {
    await follow(OWNER, FRIEND);
    const res = await getFollowing(routeRequest(`/api/v1/accounts/${encodeURIComponent(OWNER)}/following`), params(OWNER));
    expect(res.status).toBe(200);

    const body = await res.json() as { display_name: string; note: string; emojis: { shortcode: string }[] }[];
    expect(body).toHaveLength(1);
    expect(body[0].note).toContain("emojione");
    expect(body[0].note).toContain(EMOJI_URL);
    expect(body[0].emojis.map((e) => e.shortcode)).toContain("party");
    // The display name keeps the source shortcode: the client renders it.
    expect(body[0].display_name).toBe("Amiga :party:");
  });

  it("renders the bio with custom emojis in the followers list", async () => {
    await follow(FRIEND, OWNER);
    const res = await getFollowers(routeRequest(`/api/v1/accounts/${encodeURIComponent(OWNER)}/followers`), params(OWNER));
    expect(res.status).toBe(200);

    const body = await res.json() as { note: string; emojis: { shortcode: string }[] }[];
    expect(body).toHaveLength(1);
    expect(body[0].note).toContain(EMOJI_URL);
    expect(body[0].emojis.map((e) => e.shortcode)).toContain("party");
  });
});
