import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

// Privacy regression (Mastodon #36688 class): a DIRECT message that quotes a
// post must never reach the quoted author — not as a Create delivery (the
// full DM content), not as a FEP-044f QuoteRequest (the DM's IRI), and not
// as a local `quote` notification (whose payload embeds the status).
const queueMocks = vi.hoisted(() => ({ enqueueDeliveries: vi.fn(async () => {}) }));
const broadcastMocks = vi.hoisted(() => ({
  broadcastNotificationEvent: vi.fn(async () => {}),
  broadcastEvent: vi.fn(async () => {}),
  broadcastPublicStatus: vi.fn(async () => {}),
  broadcastHomeStatus: vi.fn(async () => {}),
  broadcastStatusInteraction: vi.fn(async () => {}),
  broadcastStatusInteractionToLists: vi.fn(async () => {}),
  broadcastStatusCreatedToAudience: vi.fn(async () => {}),
  broadcastStatusRefresh: vi.fn(async () => {}),
  broadcastObjectDelete: vi.fn(async () => {}),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
}));

vi.mock("@/lib/activitypub/queue", () => ({
  enqueueDeliveries: queueMocks.enqueueDeliveries,
  deliverToInbox: vi.fn(async () => {}),
}));
vi.mock("@/lib/streaming/broadcast", () => broadcastMocks);
vi.mock("@/lib/push", () => ({ deliverPushSafe: vi.fn(async () => {}) }));
vi.mock("@/lib/activitypub/federation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/federation")>()),
  // Deterministic per-actor inbox so the assertions can tell recipients apart.
  collectFollowerInboxes: vi.fn(async (ids: string[]) =>
    [...new Set(ids.map((id) => `${new URL(id).origin}/inbox`))]
  ),
  fetchRemoteObject: vi.fn(async () => null),
  signedGetHeaders: vi.fn(async () => ({})),
}));

import { POST } from "@/app/api/v1/statuses/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "t-dm-quote";
const ME = `${BASE}/users/me`;
const REC = `${BASE}/users/rec`;
const QAUTHOR = `${BASE}/users/qauthor`;
const LOCAL_POST = `${BASE}/objects/local-quoted`;
const RQA = "https://remote.example/users/rqa";
const REMOTE_POST = "https://remote.example/objects/remote-quoted";

/** Every activity JSON handed to the delivery queue, in order. */
function queuedActivities(): { type: string; targets: string[] }[] {
  const calls = queueMocks.enqueueDeliveries.mock.calls as unknown as [unknown, string[], string][];
  return calls.map(([, targets, json]) => ({
    type: String((JSON.parse(json) as { type?: unknown }).type ?? ""),
    targets,
  }));
}

async function seed(): Promise<void> {
  for (const [id, username, domain, local] of [
    [ME, "me", "local.example.test", 1],
    [REC, "rec", "local.example.test", 1],
    [QAUTHOR, "qauthor", "local.example.test", 1],
    [RQA, "rqa", "remote.example", 0],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified)
         VALUES (?, ?, ?, 'pub', ?, ?, ?, 1)`
      )
      .bind(id, username, domain, local ? "priv" : null, local, local ? `${username}@example.com` : null)
      .run();
  }
  await db
    .prepare("INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t-dmq', ?, NULL, ?, 'read write', datetime('now'))")
    .bind(ME, TOKEN)
    .run();
  // The local quoted author allows anyone to quote (skips the follow seeding).
  await db
    .prepare("INSERT INTO preferences (actor_id, key, value) VALUES (?, 'posting:default:quote_policy', 'public')")
    .bind(QAUTHOR)
    .run();
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local, raw)
       VALUES (?, 'Note', ?, '<p>local</p>', 'public', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 1, '{}')`
    )
    .bind(LOCAL_POST, QAUTHOR)
    .run();
  // The remote quoted post federates an "anyone may quote" policy, so the
  // quote validation passes without a follow.
  const remoteRaw = JSON.stringify({
    interactionPolicy: { canQuote: { automaticApproval: ["https://www.w3.org/ns/activitystreams#Public"] } },
  });
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local, raw)
       VALUES (?, 'Note', ?, '<p>remote</p>', 'public', '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z', 0, ?)`
    )
    .bind(REMOTE_POST, RQA, remoteRaw)
    .run();
}

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`${BASE}/api/v1/statuses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function quoteNotifications(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'quote'").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  vi.clearAllMocks();
  await seed();
});

describe("a direct message never leaks to a quoted author", () => {
  it("does not deliver nor QuoteRequest a DM quoting a REMOTE post", async () => {
    const res = await POST(post({ status: "secreto @rec", visibility: "direct", quoted_status_id: REMOTE_POST }) as never);
    expect(res.status).toBe(200);

    // The DM's only audience is the local recipient (a notification +
    // conversation, never a delivery): the queue must stay completely empty —
    // before the fix the quoted author's server received the full Create{DM}
    // plus a QuoteRequest carrying its IRI.
    expect(queuedActivities()).toEqual([]);
    expect(await quoteNotifications()).toBe(0);
    // The local recipient still gets their conversation.
    const conv = await db
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE actor_id = ?")
      .bind(REC)
      .first<{ n: number }>();
    expect(Number(conv?.n ?? 0)).toBe(1);
  });

  it("does not notify the LOCAL quoted author of a DM quoting their post", async () => {
    const res = await POST(post({ status: "secreto @rec", visibility: "direct", quoted_status_id: LOCAL_POST }) as never);
    expect(res.status).toBe(200);
    expect(await quoteNotifications()).toBe(0);
    expect(queuedActivities()).toEqual([]);
  });

  it("still sends the QuoteRequest and the Create for a PUBLIC quote of a remote post", async () => {
    const res = await POST(post({ status: "mirad esto", visibility: "public", quoted_status_id: REMOTE_POST }) as never);
    expect(res.status).toBe(200);

    const activities = queuedActivities();
    expect(activities.some((a) => a.type === "QuoteRequest" && a.targets.includes("https://remote.example/inbox"))).toBe(true);
    expect(activities.some((a) => a.type === "Create" && a.targets.includes("https://remote.example/inbox"))).toBe(true);
  });

  it("still notifies the LOCAL quoted author of a public quote", async () => {
    const res = await POST(post({ status: "mirad esto", visibility: "public", quoted_status_id: LOCAL_POST }) as never);
    expect(res.status).toBe(200);
    expect(await quoteNotifications()).toBe(1);
  });
});
