import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { GET as STATUS } from "@/app/api/v1/statuses/[id]/route";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const AUTHOR = "https://tuiter.rocks/users/javier";
const MENTIONED = `${BASE}/users/manalejandro`;
const FOLLOWER = `${BASE}/users/follower`;
const STRANGER = `${BASE}/users/stranger`;
const POST = "https://tuiter.rocks/users/javier/statuses/117467328616431211";

async function seedActor(id: string, opts: { local?: boolean } = {}): Promise<void> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, 1)`
    )
    .bind(id, username, domain, opts.local === false ? null : "priv", opts.local === false ? 0 : 1, `${username}@example.com`)
    .run();
}

async function seedToken(actorId: string, token: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES (?, ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(`t-${token}`, actorId, token)
    .run();
}

/** A followers-only post that mentions the local account (Mastodon delivers it there). */
async function seedPrivateMention(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local, raw)
       VALUES (?, 'Note', ?, '<p>hola @manalejandro</p>', 'private', '2026-10-19T11:26:00Z', '2026-10-19T11:26:00Z', 0, ?)`
    )
    .bind(
      POST,
      AUTHOR,
      JSON.stringify({
        id: POST,
        type: "Note",
        attributedTo: AUTHOR,
        content: "<p>hola @manalejandro</p>",
        to: [`${AUTHOR}/followers`],
        cc: [MENTIONED],
        tag: [{ type: "Mention", href: MENTIONED, name: "@manalejandro@cf-ap.com" }],
      })
    )
    .run();
}

function fetchStatus(token?: string): Promise<Response> {
  return STATUS(
    new NextRequest(`${BASE}/api/v1/statuses/${encodeURIComponent(POST)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    { params: Promise.resolve({ id: POST }) }
  );
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(AUTHOR, { local: false });
  await seedActor(MENTIONED);
  await seedActor(FOLLOWER);
  await seedActor(STRANGER);
  await seedToken(MENTIONED, "mentioned-token");
  await seedToken(FOLLOWER, "follower-token");
  await seedToken(STRANGER, "stranger-token");
  await seedPrivateMention();
});

describe("a followers-only post", () => {
  it("opens for the account it mentions", async () => {
    const res = await fetchStatus("mentioned-token");
    expect(res.status).toBe(200);
    const status = (await res.json()) as { uri: string; visibility: string };
    // `id` is the opaque REST id; `uri` is the ActivityPub one.
    expect(status.uri).toBe(POST);
    expect(status.visibility).toBe("private");
  });

  it("opens for an accepted follower", async () => {
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
      .bind(FOLLOWER, AUTHOR)
      .run();

    expect((await fetchStatus("follower-token")).status).toBe(200);
  });

  it("stays hidden from everyone else", async () => {
    expect((await fetchStatus("stranger-token")).status).toBe(404);
    expect((await fetchStatus()).status).toBe(404);
  });
});
