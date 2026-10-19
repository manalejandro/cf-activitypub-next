import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAccountUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
  broadcastObjectDelete: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusRefresh: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/push", () => ({ deliverPushSafe: vi.fn().mockResolvedValue(undefined) }));

import { POST as FOLLOW } from "@/app/api/v1/accounts/[id]/follow/route";
import { GET as ACCOUNT_SEARCH } from "@/app/api/v1/accounts/search/route";
import { GET as NOTIFICATIONS } from "@/app/api/v1/notifications/route";
import { createNotification, getNotifications, getUnreadNotificationCount } from "@/lib/db";
import { serializeNotification } from "@/lib/mastodon/serializers";
import type { LocalNotification } from "@/lib/types";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "silence-token";
const SILENCED = `${BASE}/users/limited`;
const TARGET = `${BASE}/users/target`;
const REMOTE_FAN = "https://remote.example/users/fan";

async function seedActor(
  id: string,
  opts: { local?: boolean; silenced?: boolean; role?: string } = {}
): Promise<void> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, email, email_verified, silenced)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, ?, 1, ?)`
    )
    .bind(id, username, domain, opts.local === false ? null : "priv", opts.local === false ? 0 : 1, opts.role ?? "user", `${username}@example.com`, opts.silenced ? 1 : 0)
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

function favourite(from: string, to: string): LocalNotification {
  return {
    id: `n-${Math.random().toString(36).slice(2)}`,
    type: "favourite",
    accountId: from,
    targetAccountId: to,
    objectId: null,
    read: false,
    createdAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(SILENCED, { silenced: true });
  await seedActor(TARGET);
  await seedActor(REMOTE_FAN, { local: false });
  await seedToken(SILENCED);
});

describe("limited (silenced) accounts", () => {
  it("converts the follow into a request, even when the target does not require approval", async () => {
    const res = await FOLLOW(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(TARGET)}/follow`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      { params: Promise.resolve({ id: TARGET }) }
    );
    expect(res.status).toBe(200);

    const follow = await db
      .prepare("SELECT state FROM follows WHERE actor_id = ? AND target_id = ?")
      .bind(SILENCED, TARGET)
      .first<{ state: string }>();
    expect(follow?.state).toBe("pending");

    // No accepted follow, so no counters and a follow_request notification.
    const target = await db.prepare("SELECT followers_count FROM actors WHERE id = ?").bind(TARGET).first<{ followers_count: number }>();
    expect(target?.followers_count).toBe(0);
    const notif = await db
      .prepare("SELECT type, filtered FROM notifications WHERE target_account_id = ?")
      .bind(TARGET)
      .first<{ type: string; filtered: number }>();
    expect(notif?.type).toBe("follow_request");
    // The sender is limited and the target does not follow it back: filtered.
    expect(notif?.filtered).toBe(1);
  });

  it("filters notifications unless the recipient follows the sender", async () => {
    // Not following: stored but not delivered.
    expect(await createNotification(db, favourite(SILENCED, TARGET))).toBe(false);
    const hidden = await getNotifications(db, TARGET, 10);
    expect(hidden).toHaveLength(0);
    const shown = await getNotifications(db, TARGET, 10, undefined, { filtered: true });
    expect(shown).toHaveLength(1);
    expect(shown[0].filtered).toBe(true);
    expect(await getUnreadNotificationCount(db, TARGET)).toBe(0);

    // The API exposes the flag (and the Filtered tab asks for it).
    const from = await db.prepare("SELECT * FROM actors WHERE id = ?").bind(SILENCED).first<never>();
    const serialized = serializeNotification(shown[0], from as never, "local.example.test");
    expect(serialized.filtered).toBe(true);

    const res = await NOTIFICATIONS(
      new NextRequest(`${BASE}/api/v1/notifications?filtered=true`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    );
    expect(res.status).toBe(200);

    // Following the sender: delivered normally.
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f-back', ?, ?, 'accepted')")
      .bind(TARGET, SILENCED)
      .run();
    expect(await createNotification(db, favourite(SILENCED, TARGET))).toBe(true);
    const delivered = await getNotifications(db, TARGET, 10);
    expect(delivered.some((n) => !n.filtered)).toBe(true);
  });

  it("stays findable in account search", async () => {
    const res = await ACCOUNT_SEARCH(
      new NextRequest(`${BASE}/api/v1/accounts/search?q=limited`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { username: string; limited?: boolean }[];
    expect(body.map((a) => a.username)).toContain("limited");
    expect(body.find((a) => a.username === "limited")?.limited).toBe(true);
  });
});
