import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const mocks = vi.hoisted(() => ({
  enqueueDeliveries: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/queue", () => ({ enqueueDeliveries: mocks.enqueueDeliveries }));

import { NextRequest } from "next/server";
import { POST as SUSPEND } from "@/app/api/v1/admin/accounts/[id]/suspend/route";
import { POST as UNSUSPEND } from "@/app/api/v1/admin/accounts/[id]/unsuspend/route";
import { GET as ACCOUNT } from "@/app/api/v1/accounts/[id]/route";
import { GET as ACTOR_DOCUMENT } from "@/app/api/users/[username]/route";
import { GET as STATUSES } from "@/app/api/v1/accounts/[id]/statuses/route";
import { GET as STATUS } from "@/app/api/v1/statuses/[id]/route";
import { suspendAccount } from "@/lib/moderation/actions";

const db = env.DB;
// The federation builds actor ids from INSTANCE_URL (wrangler.toml), so the
// seeded rows have to use the same host.
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const TOKEN = "suspend-token";
const ADMIN = `${BASE}/users/admin`;
const SPAMMER = `${BASE}/users/spammer`;
const FOLLOWER = "https://remote.example/users/fan";
const SHARED_INBOX = "https://remote.example/inbox";

async function seedActor(
  id: string,
  opts: { local?: boolean; role?: string; sharedInbox?: string | null; suspended?: boolean } = {}
): Promise<string> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, role, shared_inbox, email, email_verified, suspended)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, ?, ?, 1, ?)`
    )
    .bind(
      id,
      username,
      domain,
      opts.local === false ? null : "priv",
      opts.local === false ? 0 : 1,
      opts.role ?? "user",
      opts.sharedInbox ?? null,
      `${username}@example.com`,
      opts.suspended ? 1 : 0
    )
    .run();
  return id;
}

async function seedToken(actorId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(actorId, TOKEN)
    .run();
}

async function seedStatus(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, '<p>spam</p>', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
    )
    .bind(`${BASE}/objects/1`, SPAMMER)
    .run();
}

function adminCall(handler: typeof SUSPEND, id: string): Promise<Response> {
  return handler(
    new NextRequest(`${BASE}/api/v1/admin/accounts/${encodeURIComponent(id)}/${handler === SUSPEND ? "suspend" : "unsuspend"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    { params: Promise.resolve({ id }) }
  );
}

function lastActivity(): { type: string; actor: string; object: { id: string; suspended?: boolean } } {
  const call = mocks.enqueueDeliveries.mock.calls.at(-1) as [unknown, string[], string] | undefined;
  expect(call).toBeTruthy();
  expect(call![1]).toEqual([SHARED_INBOX]);
  return JSON.parse(call![2]) as { type: string; actor: string; object: { id: string; suspended?: boolean } };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  mocks.enqueueDeliveries.mockClear();
  await seedActor(ADMIN, { role: "admin" });
  await seedToken(ADMIN);
  await seedActor(SPAMMER);
  await seedActor(FOLLOWER, { local: false, sharedInbox: SHARED_INBOX });
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
    .bind(FOLLOWER, SPAMMER)
    .run();
});

describe("suspending an account", () => {
  it("disconnects it from the fediverse: an Update{Actor} with suspended: true", async () => {
    const res = await adminCall(SUSPEND, SPAMMER);
    expect(res.status).toBe(200);

    const row = await db
      .prepare("SELECT suspended, suspended_at FROM actors WHERE id = ?")
      .bind(SPAMMER)
      .first<{ suspended: number; suspended_at: string | null }>();
    expect(row?.suspended).toBe(1);
    expect(row?.suspended_at).not.toBeNull();

    const activity = lastActivity();
    expect(activity.type).toBe("Update");
    expect(activity.actor).toBe(SPAMMER);
    expect(activity.object.id).toBe(SPAMMER);
    expect(activity.object.suspended).toBe(true);
  });

  it("tells the followers when the account is back", async () => {
    await adminCall(SUSPEND, SPAMMER);
    mocks.enqueueDeliveries.mockClear();

    const res = await adminCall(UNSUSPEND, SPAMMER);
    expect(res.status).toBe(200);

    const activity = lastActivity();
    expect(activity.type).toBe("Update");
    expect(activity.object.suspended).toBeUndefined();
    const row = await db.prepare("SELECT suspended, suspended_at FROM actors WHERE id = ?").bind(SPAMMER).first<{ suspended: number; suspended_at: string | null }>();
    expect(row?.suspended).toBe(0);
    expect(row?.suspended_at).toBeNull();
  });

  it("distributes from the moderation action too", async () => {
    const result = await suspendAccount(
      { DB: env.DB, KV: env.KV, INSTANCE_URL: BASE },
      { actorId: SPAMMER, reason: "spam", source: "ai", model: "test" }
    );
    expect(result.applied).toBe(true);
    expect(lastActivity().object.suspended).toBe(true);
  });

  it("marks the account entity and hides its posts", async () => {
    await seedStatus();
    await adminCall(SUSPEND, SPAMMER);

    const accountRes = await ACCOUNT(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(SPAMMER)}`),
      { params: Promise.resolve({ id: SPAMMER }) }
    );
    const account = (await accountRes.json()) as { suspended?: boolean };
    expect(account.suspended).toBe(true);

    const statusesRes = await STATUSES(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(SPAMMER)}/statuses`),
      { params: Promise.resolve({ id: SPAMMER }) }
    );
    expect(await statusesRes.json()).toEqual([]);

    // The permalink is gone too: it must not keep serving the media and the
    // card the account uploaded.
    const statusRes = await STATUS(
      new NextRequest(`${BASE}/api/v1/statuses/${encodeURIComponent(`${BASE}/objects/1`)}`),
      { params: Promise.resolve({ id: `${BASE}/objects/1` }) }
    );
    expect(statusRes.status).toBe(404);
  });

  it("stops serving the uploaded avatar and header", async () => {
    await db
      .prepare("UPDATE actors SET avatar_url = ?, header_url = ? WHERE id = ?")
      .bind(`${BASE}/media/spammer-avatar.png`, `${BASE}/media/spammer-header.png`, SPAMMER)
      .run();

    const before = (await (await ACCOUNT(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(SPAMMER)}`),
      { params: Promise.resolve({ id: SPAMMER }) }
    )).json()) as { avatar: string; header: string };
    expect(before.avatar).toBe(`${BASE}/media/spammer-avatar.png`);

    await adminCall(SUSPEND, SPAMMER);

    const account = (await (await ACCOUNT(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(SPAMMER)}`),
      { params: Promise.resolve({ id: SPAMMER }) }
    )).json()) as { avatar: string; avatar_static: string; header: string; header_static: string };
    expect(account.avatar).toBe(`${BASE}/default-avatar.png`);
    expect(account.avatar_static).toBe(`${BASE}/default-avatar.png`);
    expect(account.header).toBe(`${BASE}/default-header.png`);
    expect(account.header_static).toBe(`${BASE}/default-header.png`);

    // The federated document advertises no profile media either.
    const apRes = await ACTOR_DOCUMENT(
      new NextRequest(`${BASE}/api/users/spammer`),
      { params: Promise.resolve({ username: "spammer" }) }
    );
    const ap = (await apRes.json()) as { suspended?: boolean; icon?: unknown; image?: unknown };
    expect(ap.suspended).toBe(true);
    expect(ap.icon).toBeUndefined();
    expect(ap.image).toBeUndefined();

    // Reinstating the account brings the uploaded files back (nothing was lost).
    await adminCall(UNSUSPEND, SPAMMER);
    const restored = (await (await ACCOUNT(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(SPAMMER)}`),
      { params: Promise.resolve({ id: SPAMMER }) }
    )).json()) as { avatar: string; header: string };
    expect(restored.avatar).toBe(`${BASE}/media/spammer-avatar.png`);
    expect(restored.header).toBe(`${BASE}/media/spammer-header.png`);
  });
});
