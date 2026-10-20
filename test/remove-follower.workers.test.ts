import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const mocks = vi.hoisted(() => ({ enqueueDeliveries: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/activitypub/queue", () => ({ enqueueDeliveries: mocks.enqueueDeliveries }));

import { POST as REMOVE_FOLLOWER } from "@/app/api/v1/accounts/[id]/remove_from_followers/route";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const ME = `${BASE}/users/me`;
const REMOTE_FAN = "https://remote.example/users/fan";
const REMOTE_INBOX = "https://remote.example/users/fan/inbox";
const LOCAL_FAN = `${BASE}/users/local-fan`;
const TOKEN = "remove-follower-token";

async function seed(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, email, email_verified, inbox)
       VALUES (?, 'me', ?, 'pub', 'priv', 1, 1, 'me@example.com', 1, NULL),
              (?, 'local-fan', ?, 'pub', 'priv', 1, 1, 'fan@example.com', 1, NULL),
              (?, 'fan', 'remote.example', 'pub', NULL, 0, 1, 'fan@remote.example', 1, ?)`
    )
    .bind(ME, new URL(ME).hostname, LOCAL_FAN, new URL(LOCAL_FAN).hostname, REMOTE_FAN, REMOTE_INBOX)
    .run();
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at)
       VALUES ('t-rm', ?, NULL, ?, 'read write', datetime('now'))`
    )
    .bind(ME, TOKEN)
    .run();
  await db
    .prepare(
      `INSERT INTO follows (id, actor_id, target_id, state, activity_id)
       VALUES ('f-remote', ?, ?, 'accepted', 'https://remote.example/activities/follow-1'),
              ('f-local', ?, ?, 'accepted', ?)`
    )
    .bind(REMOTE_FAN, ME, LOCAL_FAN, ME, `${BASE}/activities/follow-2`)
    .run();
}

function remove(followerId: string): Promise<Response> {
  return REMOVE_FOLLOWER(
    new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(followerId)}/remove_from_followers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    { params: Promise.resolve({ id: followerId }) }
  );
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  mocks.enqueueDeliveries.mockClear();
  await seed();
});

describe("removing an account from your followers", () => {
  it("tells the remote follower with a Reject{Follow} through the queue", async () => {
    const res = await remove(REMOTE_FAN);
    expect(res.status).toBe(200);

    const call = mocks.enqueueDeliveries.mock.calls.at(-1) as [unknown, string[], string] | undefined;
    expect(call).toBeTruthy();
    // Mastodon's RemoveFromFollowersService delivers to the follower's personal
    // inbox, not its shared one.
    expect(call![1]).toEqual([REMOTE_INBOX]);
    const activity = JSON.parse(call![2]) as {
      type: string;
      actor: string;
      object: { type: string; id: string; actor: string; object: string };
    };
    expect(activity).toMatchObject({
      type: "Reject",
      actor: ME,
      object: {
        type: "Follow",
        id: "https://remote.example/activities/follow-1",
        actor: REMOTE_FAN,
        object: ME,
      },
    });

    const follow = await db
      .prepare("SELECT COUNT(*) AS n FROM follows WHERE actor_id = ? AND target_id = ?")
      .bind(REMOTE_FAN, ME)
      .first<{ n: number }>();
    expect(follow?.n).toBe(0);
  });

  it("delivers nothing for a local follower (the follow is simply gone)", async () => {
    expect((await remove(LOCAL_FAN)).status).toBe(200);
    expect(mocks.enqueueDeliveries).not.toHaveBeenCalled();
  });

  it("delivers nothing when there was no accepted follow", async () => {
    await db.prepare("DELETE FROM follows WHERE id = 'f-remote'").run();
    expect((await remove(REMOTE_FAN)).status).toBe(200);
    expect(mocks.enqueueDeliveries).not.toHaveBeenCalled();
  });
});
