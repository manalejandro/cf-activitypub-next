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
import { createNotification, getNotifications, getUnreadNotificationCount } from "@/lib/db";
import type { LocalNotification } from "@/lib/types";

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

/** A mention from `SPAMMER` waiting in the local admin's notifications. */
async function seedNotification(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, type, account_id, target_account_id, object_id, is_read, filtered, created_at)
       VALUES ('n1', 'mention', ?, ?, ?, 0, 0, '2026-10-01T10:00:00Z')`
    )
    .bind(SPAMMER, ADMIN, `${BASE}/objects/1`)
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
  it("stores a notification from a suspended account but never delivers it", async () => {
    await seedStatus();
    await adminCall(SUSPEND, SPAMMER);

    // A stale activity from its server: the row is kept (reinstating the
    // account restores it) but nothing may interrupt the recipient — no stream
    // event, no push, no email.
    const notif: LocalNotification = {
      id: "n-late",
      type: "mention",
      accountId: SPAMMER,
      targetAccountId: ADMIN,
      objectId: `${BASE}/objects/1`,
      read: false,
      createdAt: new Date().toISOString(),
    };
    expect(await createNotification(db, notif)).toBe(false);
    expect(await getNotifications(db, ADMIN)).toHaveLength(0);
    const stored = await db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE id = 'n-late'")
      .first<{ n: number }>();
    expect(stored?.n).toBe(1);

    await adminCall(UNSUSPEND, SPAMMER);
    expect(await getNotifications(db, ADMIN)).toHaveLength(1);
  });

  it("stops serving the notifications it sent (and brings them back on reinstatement)", async () => {
    await seedStatus();
    await seedNotification();

    // Before: the mention is in the list and counts as unread.
    expect(await getNotifications(db, ADMIN)).toHaveLength(1);
    expect(await getUnreadNotificationCount(db, ADMIN)).toBe(1);

    await adminCall(SUSPEND, SPAMMER);

    // A suspension is "removed publicly": its mentions are not served either —
    // neither the list nor the badge, which must agree.
    expect(await getNotifications(db, ADMIN)).toHaveLength(0);
    expect(await getUnreadNotificationCount(db, ADMIN)).toBe(0);
    // The row is only hidden, never deleted.
    const stored = await db.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
    expect(stored?.n).toBe(1);

    await adminCall(UNSUSPEND, SPAMMER);

    expect(await getNotifications(db, ADMIN)).toHaveLength(1);
    expect(await getUnreadNotificationCount(db, ADMIN)).toBe(1);
  });

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

  it("restores the blanked content on reinstatement, except individually deleted statuses", async () => {
    // Two posts with their AP documents stored in `raw` (the suspension
    // blanket NULLs `content`; `raw` is what the reinstatement restores from).
    for (const [n, sensitive] of [["r1", false], ["r2", true]] as const) {
      await db
        .prepare(
          `INSERT INTO objects (id, type, actor_id, content, raw, visibility, published, updated_at, is_local)
           VALUES (?, 'Note', ?, ?, ?, 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
        )
        .bind(
          `${BASE}/objects/${n}`,
          SPAMMER,
          `<p>post ${n}</p>`,
          JSON.stringify({ id: `${BASE}/objects/${n}`, content: `<p>post ${n}</p>`, sensitive })
        )
        .run();
    }
    // r2 was ALSO deleted individually by moderation before the suspension:
    // its removal is audited and must survive the reinstatement.
    await db
      .prepare(
        "INSERT INTO moderation_log (id, source, target_type, target_id, action, created_at) VALUES ('ml-r2', 'user', 'status', ?, 'deleted', datetime('now'))"
      )
      .bind(`${BASE}/objects/r2`)
      .run();
    await db
      .prepare("UPDATE objects SET content = NULL, sensitive = 1 WHERE id = ?")
      .bind(`${BASE}/objects/r2`)
      .run();

    const suspended = await suspendAccount(
      { DB: env.DB, KV: env.KV, INSTANCE_URL: BASE },
      { actorId: SPAMMER, reason: "spam", source: "ai", model: "test" }
    );
    expect(suspended.applied).toBe(true);

    const blanked = await db
      .prepare("SELECT id, content FROM objects WHERE actor_id = ? AND content IS NULL")
      .bind(SPAMMER)
      .all<{ id: string }>();
    expect(blanked.results.map((r) => r.id).sort()).toEqual([`${BASE}/objects/r1`, `${BASE}/objects/r2`]);

    await adminCall(UNSUSPEND, SPAMMER);

    const r1 = await db
      .prepare("SELECT content, sensitive, updated_at FROM objects WHERE id = ?")
      .bind(`${BASE}/objects/r1`)
      .first<{ content: string | null; sensitive: number; updated_at: string }>();
    expect(r1?.content).toBe("<p>post r1</p>");
    expect(r1?.sensitive).toBe(0); // restored from the document, not the blanket's 1
    expect(r1?.updated_at).toBe("2026-10-01T10:00:00Z"); // a reinstatement is not an edit

    const r2 = await db
      .prepare("SELECT content FROM objects WHERE id = ?")
      .bind(`${BASE}/objects/r2`)
      .first<{ content: string | null }>();
    expect(r2?.content).toBeNull(); // individually deleted: stays deleted
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
      .prepare("UPDATE actors SET avatar_url = ?, header_url = ?, display_name = ?, summary = ? WHERE id = ?")
      .bind(`${BASE}/media/spammer-avatar.png`, `${BASE}/media/spammer-header.png`, "Ofertas Ya", "Sígueme y gana dinero", SPAMMER)
      .run();
    await db
      .prepare("INSERT INTO actor_fields (id, actor_id, name, value, position) VALUES ('f1', ?, 'Web', 'https://spam.example', 0)")
      .bind(SPAMMER)
      .run();

    const before = (await (await ACCOUNT(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(SPAMMER)}`),
      { params: Promise.resolve({ id: SPAMMER }) }
    )).json()) as { avatar: string; header: string; display_name: string; note: string; fields: unknown[] };
    expect(before.avatar).toBe(`${BASE}/media/spammer-avatar.png`);
    expect(before.display_name).toBe("Ofertas Ya");
    expect(before.note).toContain("gana dinero");
    expect(before.fields).toHaveLength(1);

    await adminCall(SUSPEND, SPAMMER);

    const account = (await (await ACCOUNT(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(SPAMMER)}`),
      { params: Promise.resolve({ id: SPAMMER }) }
    )).json()) as { avatar: string; avatar_static: string; header: string; header_static: string; display_name: string; note: string; fields: unknown[] };
    expect(account.avatar).toBe(`${BASE}/default-avatar.png`);
    expect(account.avatar_static).toBe(`${BASE}/default-avatar.png`);
    expect(account.header).toBe(`${BASE}/default-header.png`);
    expect(account.header_static).toBe(`${BASE}/default-header.png`);
    // Nothing the account wrote survives either: only the handle.
    expect(account.display_name).toBe("spammer");
    expect(account.note).toBe("");
    expect(account.fields).toEqual([]);

    // The federated document advertises no profile media either.
    const apRes = await ACTOR_DOCUMENT(
      new NextRequest(`${BASE}/api/users/spammer`),
      { params: Promise.resolve({ username: "spammer" }) }
    );
    const ap = (await apRes.json()) as { suspended?: boolean; icon?: unknown; image?: unknown; name?: string; summary?: string; attachment?: unknown };
    expect(ap.suspended).toBe(true);
    expect(ap.icon).toBeUndefined();
    expect(ap.image).toBeUndefined();
    expect(ap.name).toBe("spammer");
    expect(ap.summary).toBe("");
    expect(ap.attachment).toBeUndefined();

    // Reinstating the account brings the uploaded files back (nothing was lost).
    await adminCall(UNSUSPEND, SPAMMER);
    const restored = (await (await ACCOUNT(
      new NextRequest(`${BASE}/api/v1/accounts/${encodeURIComponent(SPAMMER)}`),
      { params: Promise.resolve({ id: SPAMMER }) }
    )).json()) as { avatar: string; header: string; display_name: string; note: string; fields: unknown[] };
    expect(restored.avatar).toBe(`${BASE}/media/spammer-avatar.png`);
    expect(restored.header).toBe(`${BASE}/media/spammer-header.png`);
    expect(restored.display_name).toBe("Ofertas Ya");
    expect(restored.note).toContain("gana dinero");
    expect(restored.fields).toHaveLength(1);
  });
});
