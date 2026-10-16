import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";
import { notifyExpiredPolls } from "@/lib/activitypub/polls";

const db = env.DB;
const BASE = "https://local.example.test";
const REMOTE_AUTHOR = "https://remote.example/users/poller";
const LOCAL_AUTHOR = `${BASE}/users/me`;
const VOTER = `${BASE}/users/voter`;
const OTHER_VOTER = `${BASE}/users/other`;
const POLL_OBJECT = "https://remote.example/objects/poll1";
const LOCAL_POLL_OBJECT = `${BASE}/objects/poll2`;

async function seedActor(id: string, local: boolean): Promise<void> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, 1)`
    )
    .bind(id, username, domain, local ? "priv" : null, local ? 1 : 0, `${username}@example.com`)
    .run();
}

async function seedPoll(opts: {
  objectId: string;
  authorId: string;
  local: boolean;
  expiresAt: string;
  voters?: string[];
  pollId?: string;
}): Promise<string> {
  const pollId = opts.pollId ?? `poll-${Math.random().toString(36).slice(2)}`;
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
       VALUES (?, 'Question', ?, '<p>¿?</p>', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', ?)`
    )
    .bind(opts.objectId, opts.authorId, opts.local ? 1 : 0)
    .run();
  await db
    .prepare(
      `INSERT INTO polls (id, object_id, expires_at, multiple, votes_count, voters_count)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
    .bind(pollId, opts.objectId, opts.expiresAt, (opts.voters ?? []).length, (opts.voters ?? []).length)
    .run();
  for (const [i, voter] of (opts.voters ?? []).entries()) {
    await db
      .prepare("INSERT INTO poll_votes (id, poll_id, actor_id, option_idx) VALUES (?, ?, ?, 0)")
      .bind(`vote-${pollId}-${i}`, pollId, voter)
      .run();
  }
  return pollId;
}

async function pollNotifications(): Promise<{ target: string; type: string }[]> {
  const rows = await db
    .prepare("SELECT target_account_id AS target, type FROM notifications WHERE type = 'poll' ORDER BY target_account_id")
    .bind()
    .all<{ target: string; type: string }>();
  return rows.results ?? [];
}

const EXPIRED = new Date(Date.now() - 60_000).toISOString();
const OPEN = new Date(Date.now() + 3_600_000).toISOString();
const ANCIENT = new Date(Date.now() - 30 * 86_400_000).toISOString();

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(REMOTE_AUTHOR, false);
  await seedActor(LOCAL_AUTHOR, true);
  await seedActor(VOTER, true);
  await seedActor(OTHER_VOTER, true);
});

describe("poll expiration notifications", () => {
  it("notifies every local voter of an expired remote poll", async () => {
    await seedPoll({
      objectId: POLL_OBJECT,
      authorId: REMOTE_AUTHOR,
      local: false,
      expiresAt: EXPIRED,
      voters: [VOTER, OTHER_VOTER],
    });

    expect(await notifyExpiredPolls(env as never)).toBe(1);

    const notified = await pollNotifications();
    expect(notified.map((n) => n.target)).toEqual([OTHER_VOTER, VOTER, REMOTE_AUTHOR].sort());
  });

  it("is idempotent: the author's notification marks the poll as done", async () => {
    await seedPoll({
      objectId: POLL_OBJECT,
      authorId: REMOTE_AUTHOR,
      local: false,
      expiresAt: EXPIRED,
      voters: [VOTER],
    });

    expect(await notifyExpiredPolls(env as never)).toBe(1);
    const afterFirst = await pollNotifications();

    // The marker (the author's notification) is already there: nothing to do,
    // and no duplicate is delivered either.
    expect(await notifyExpiredPolls(env as never)).toBe(0);
    expect(await pollNotifications()).toEqual(afterFirst);
  });

  it("notifies the author of a local poll too", async () => {
    await seedPoll({
      objectId: LOCAL_POLL_OBJECT,
      authorId: LOCAL_AUTHOR,
      local: true,
      expiresAt: EXPIRED,
      voters: [VOTER],
    });

    expect(await notifyExpiredPolls(env as never)).toBe(1);
    const notified = await pollNotifications();
    expect(notified.map((n) => n.target)).toEqual([LOCAL_AUTHOR, VOTER].sort());
  });

  it("leaves open polls and ancient history alone", async () => {
    await seedPoll({ objectId: `${BASE}/objects/open`, authorId: LOCAL_AUTHOR, local: true, expiresAt: OPEN, voters: [VOTER] });
    await seedPoll({ objectId: `${BASE}/objects/ancient`, authorId: LOCAL_AUTHOR, local: true, expiresAt: ANCIENT, voters: [VOTER] });

    expect(await notifyExpiredPolls(env as never)).toBe(0);
    expect(await pollNotifications()).toEqual([]);
  });
});
