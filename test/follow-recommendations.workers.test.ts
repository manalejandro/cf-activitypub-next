import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { refreshFollowRecommendations, readFollowRecommendations, FOLLOW_RECOMMENDATIONS_KEY } from "@/lib/follow-recommendations";
import { getAccountSuggestions } from "@/lib/db";

const db = env.DB;
const BASE = "https://local.example.test";

async function seedActor(id: string, opts: { local?: boolean; lastActiveDaysAgo?: number | null } = {}): Promise<string> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  const lastActive = opts.lastActiveDaysAgo === null || opts.lastActiveDaysAgo === undefined
    ? null
    : new Date(Date.now() - opts.lastActiveDaysAgo * 86_400_000).toISOString();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, last_status_at, last_active_at)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, ?)`
    )
    .bind(id, username, domain, opts.local ? "priv" : null, opts.local ? 1 : 0, new Date().toISOString(), lastActive)
    .run();
  return id;
}

async function seedFollow(actorId: string, targetId: string): Promise<void> {
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?, ?, ?, 'accepted')")
    .bind(`f-${actorId}-${targetId}`, actorId, targetId)
    .run();
}

async function seedObject(id: string, actorId: string, engagement: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, engagement, is_local, raw)
       VALUES (?, 'Note', ?, '<p>x</p>', 'public', ?, ?, ?, 0, '{}')`
    )
    .bind(id, actorId, new Date().toISOString(), new Date().toISOString(), engagement)
    .run();
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
});

describe("follow recommendations (Mastodon's FollowRecommendation)", () => {
  it("ranks what the active locals follow and engage with, skipping suspended accounts", async () => {
    const active = await seedActor(`${BASE}/users/active`, { local: true, lastActiveDaysAgo: 1 });
    const idle = await seedActor(`${BASE}/users/idle`, { local: true, lastActiveDaysAgo: 90 });
    const followed = "https://remote.example/users/followed";
    const engaged = "https://remote.example/users/engaged";
    const suspended = "https://remote.example/users/bad";
    await seedActor(followed, { local: false });
    await seedActor(engaged, { local: false });
    await seedActor(suspended, { local: false });
    await db.prepare("UPDATE actors SET suspended = 1 WHERE id = ?").bind(suspended).run();

    await seedFollow(active, followed);
    await seedFollow(idle, followed); // the idle follower must not count
    await seedFollow(active, suspended);
    await seedObject("https://remote.example/objects/1", engaged, 40);

    const count = await refreshFollowRecommendations({ DB: db, KV: env.KV });

    expect(count).toBe(2);
    const ids = await readFollowRecommendations({ DB: db, KV: env.KV });
    // `engaged` (interactions) ranks above `followed` (one active follower).
    expect(ids).toEqual([engaged, followed]);
    expect(ids).not.toContain(suspended);
    expect(await env.KV.get(FOLLOW_RECOMMENDATIONS_KEY)).toBeTruthy();
  });

  it("returns an empty list when the ranking was never computed", async () => {
    expect(await readFollowRecommendations({ DB: db, KV: env.KV })).toEqual([]);
  });

  it("serves the ranking as a suggestion pool, still honouring the viewer's own follows", async () => {
    const viewer = await seedActor(`${BASE}/users/viewer`, { local: true, lastActiveDaysAgo: 1 });
    const a = "https://remote.example/users/a";
    const b = "https://remote.example/users/b";
    await seedActor(a, { local: false });
    await seedActor(b, { local: false });
    await seedFollow(viewer, a);

    const suggestions = await getAccountSuggestions(db, viewer, { limit: 20, recommendedIds: [a, b] });
    const byUsername = new Map(suggestions.map((s) => [s.actor.username, s.source]));

    expect(byUsername.get("b")).toBe("global");
    expect(byUsername.has("a")).toBe(false);
  });
});
