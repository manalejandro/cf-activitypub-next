import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { getActorById } from "@/lib/db";
import { performMove } from "@/lib/activitypub/migration";

const db = env.DB;
const BASE = "https://local.example.test";
const ME = `${BASE}/users/me`;
const FAN = `${BASE}/users/fan`;
const TARGET = "https://fedisocial.example/users/me";
const REMOTE_FAN_A = "https://remote.example/users/a";
const REMOTE_FAN_B = "https://remote.example/users/b";

async function seedActor(id: string, opts: { local: boolean; inbox?: string }): Promise<void> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, inbox, followers_count, following_count)
       VALUES (?, ?, ?, 'pub', ?, ?, ?, 0, 0)`
    )
    .bind(id, username, domain, opts.local ? "priv" : null, opts.local ? 1 : 0, opts.inbox ?? `${id}/inbox`)
    .run();
}

async function seedFollow(actorId: string, targetId: string): Promise<void> {
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?, ?, ?, 'accepted')")
    .bind(`f-${actorId}-${targetId}`, actorId, targetId)
    .run();
}

function fakeQueue() {
  const sent: { body: { inboxUrl: string; activityJson: string; actorId: string } }[] = [];
  return {
    sent,
    queue: {
      sendBatch: vi.fn(async (messages: { body: { inboxUrl: string; activityJson: string; actorId: string } }[]) => {
        sent.push(...messages);
      }),
    } as unknown as Parameters<typeof performMove>[4],
  };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
});

describe("performMove", () => {
  it("re-follows the target for local followers and delivers the Move to remote servers", async () => {
    await seedActor(ME, { local: true });
    await seedActor(FAN, { local: true });
    await seedActor(TARGET, { local: false, inbox: "https://fedisocial.example/inbox" });
    await seedActor(REMOTE_FAN_A, { local: false, inbox: "https://remote.example/users/a/inbox" });
    await seedActor(REMOTE_FAN_B, { local: false, inbox: "https://remote.example/users/b/inbox" });
    await seedFollow(FAN, ME);
    await seedFollow(REMOTE_FAN_A, ME);
    await seedFollow(REMOTE_FAN_B, ME);
    await db.prepare("UPDATE actors SET followers_count = 3 WHERE id = ?").bind(ME).run();

    const source = (await getActorById(db, ME))!;
    const target = (await getActorById(db, TARGET))!;
    const fake = fakeQueue();

    const result = await performMove(db, BASE, source, target, fake.queue);

    expect(result).toEqual({ migratedLocal: 1, delivered: 1 });

    // The move is recorded on the source.
    const moved = await db
      .prepare("SELECT moved_to, also_known_as, followers_count FROM actors WHERE id = ?")
      .bind(ME)
      .first<{ moved_to: string; also_known_as: string; followers_count: number }>();
    expect(moved!.moved_to).toBe(TARGET);
    expect(JSON.parse(moved!.also_known_as)).toContain(TARGET);
    expect(moved!.followers_count).toBe(2); // the local follower moved away

    // The local follower now follows the target…
    const localFollow = await db
      .prepare("SELECT state FROM follows WHERE actor_id = ? AND target_id = ?")
      .bind(FAN, TARGET)
      .first<{ state: string }>();
    expect(localFollow?.state).toBe("accepted");
    // …and the target's instance is told with a Follow signed by the follower.
    const followActivity = fake.sent.find((m) => m.body.activityJson.includes('"type":"Follow"'));
    expect(followActivity?.body.inboxUrl).toBe("https://fedisocial.example/inbox");
    expect(followActivity?.body.actorId).toBe(FAN);

    // The Move goes to the remote followers, one message per inbox.
    const moveMessages = fake.sent.filter((m) => m.body.activityJson.includes('"type":"Move"'));
    expect(moveMessages).toHaveLength(2);
    const payload = JSON.parse(moveMessages[0].body.activityJson) as { object: string; target: string };
    expect(payload.object).toBe(ME);
    expect(payload.target).toBe(TARGET);
    expect(moveMessages[0].body.actorId).toBe(ME);
  });

  it("reports one server even with several followers on the same domain", async () => {
    await seedActor(ME, { local: true });
    await seedActor(TARGET, { local: false, inbox: "https://fedisocial.example/inbox" });
    await seedActor(REMOTE_FAN_A, { local: false, inbox: "https://remote.example/users/a/inbox" });
    await seedActor(REMOTE_FAN_B, { local: false, inbox: "https://remote.example/users/b/inbox" });
    await seedFollow(REMOTE_FAN_A, ME);
    await seedFollow(REMOTE_FAN_B, ME);

    const source = (await getActorById(db, ME))!;
    const target = (await getActorById(db, TARGET))!;
    const fake = fakeQueue();

    const result = await performMove(db, BASE, source, target, fake.queue);

    expect(result.delivered).toBe(1);
  });

  it("delivers nothing when there are no remote followers", async () => {
    await seedActor(ME, { local: true });
    await seedActor(TARGET, { local: false, inbox: "https://fedisocial.example/inbox" });

    const source = (await getActorById(db, ME))!;
    const target = (await getActorById(db, TARGET))!;
    const fake = fakeQueue();

    const result = await performMove(db, BASE, source, target, fake.queue);

    expect(result).toEqual({ migratedLocal: 0, delivered: 0 });
    expect(fake.sent).toHaveLength(0);
  });
});
