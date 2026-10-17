import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const queueMocks = vi.hoisted(() => ({ enqueueDeliveries: vi.fn(async () => {}) }));
const broadcastMocks = vi.hoisted(() => ({
  broadcastNotificationEvent: vi.fn(async () => {}),
  broadcastEvent: vi.fn(async () => {}),
  broadcastPublicStatus: vi.fn(async () => {}),
  broadcastHomeStatus: vi.fn(async () => {}),
  broadcastStatusInteraction: vi.fn(async () => {}),
  broadcastStatusInteractionToLists: vi.fn(async () => {}),
  broadcastStatusCreatedToAudience: vi.fn(async () => {}),
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
  collectFollowerInboxes: vi.fn(async () => ["https://remote.example/inbox"]),
  deliverToInbox: vi.fn(async () => {}),
  fetchRemoteObject: vi.fn(async () => null),
  signedGetHeaders: vi.fn(async () => ({})),
}));

import { processInboxActivity } from "@/lib/activitypub/inbox";
import { getObjectById, getQuoteAuthorizationByInteractingObject } from "@/lib/db";
import { GET as AUTHORIZATION } from "@/app/quote_authorizations/[id]/route";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const AUTHOR = `${BASE}/users/alice`;
const REMOTE_AUTHOR = "https://remote.example/users/bob";
const REMOTE_POST = "https://remote.example/objects/quoted";
const LOCAL_POST = `${BASE}/objects/quoted-local`;
const QUOTING_POST = `${BASE}/objects/quoting`;

/** The last activity handed to the delivery queue, by type. */
function queued(type: string): Record<string, unknown> | null {
  const calls = queueMocks.enqueueDeliveries.mock.calls as unknown as [unknown, string[], string][];
  for (let i = calls.length - 1; i >= 0; i--) {
    const parsed = JSON.parse(calls[i][2]) as Record<string, unknown>;
    if (parsed.type === type) return parsed;
  }
  return null;
}

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

async function seedObject(id: string, actorId: string, opts: { local?: boolean; visibility?: string; quoteId?: string; raw?: string } = {}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, published, updated_at, is_local, quote_id, raw)
       VALUES (?, 'Note', ?, '<p>hola</p>', ?, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', ?, ?, ?)`
    )
    .bind(id, actorId, opts.visibility ?? "public", opts.local === false ? 0 : 1, opts.quoteId ?? null, opts.raw ?? "{}")
    .run();
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  queueMocks.enqueueDeliveries.mockClear();
  await seedActor(AUTHOR);
  await seedActor(REMOTE_AUTHOR, { local: false });
});

describe("FEP-044f quote authorizations", () => {
  it("serves the authorization we issue for a local post", async () => {
    await seedObject(LOCAL_POST, AUTHOR);

    const { ensureLocalQuoteAuthorization } = await import("@/lib/activitypub/quotes");
    const quoted = await getObjectById(db, LOCAL_POST);
    const uri = await ensureLocalQuoteAuthorization(env, {
      baseUrl: BASE,
      quoted: quoted!,
      authorUsername: "alice",
      interactingObjectId: QUOTING_POST,
    });

    expect(uri).toBeTruthy();
    const id = uri!.split("/").pop()!;
    const res = await AUTHORIZATION(
      new NextRequest(uri!),
      { params: Promise.resolve({ id }) }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("activity+json");
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.type).toBe("QuoteAuthorization");
    expect(doc.id).toBe(uri);
    expect(doc.attributedTo).toBe(AUTHOR);
    expect(doc.interactingObject).toBe(QUOTING_POST);
    expect(doc.interactionTarget).toBe(LOCAL_POST);
  });

  it("accepts a remote QuoteRequest for a public post and issues an authorization", async () => {
    await seedObject(LOCAL_POST, AUTHOR);
    const request = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/req-1",
      type: "QuoteRequest",
      actor: REMOTE_AUTHOR,
      object: LOCAL_POST,
      instrument: "https://remote.example/objects/their-quote",
    };

    await processInboxActivity(request as never, { db, baseUrl: BASE, deliveryQueue: {} } as never);

    const auth = await getQuoteAuthorizationByInteractingObject(db, "https://remote.example/objects/their-quote");
    expect(auth).not.toBeNull();
    expect(auth!.objectId).toBe(LOCAL_POST);

    const accept = queued("Accept");
    expect(accept).not.toBeNull();
    expect(accept!.result).toBe(`${BASE}/quote_authorizations/${auth!.id}`);
    // The echoed request keeps the pair Mastodon checks.
    const echoed = accept!.object as Record<string, unknown>;
    expect(echoed.object).toBe(LOCAL_POST);
    expect(echoed.instrument).toBe("https://remote.example/objects/their-quote");
  });

  it("refuses a QuoteRequest for a private post", async () => {
    await seedObject(LOCAL_POST, AUTHOR, { visibility: "private" });
    const request = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/req-2",
      type: "QuoteRequest",
      actor: REMOTE_AUTHOR,
      object: LOCAL_POST,
      instrument: "https://remote.example/objects/their-quote",
    };

    await processInboxActivity(request as never, { db, baseUrl: BASE, deliveryQueue: {} } as never);

    expect(await getQuoteAuthorizationByInteractingObject(db, "https://remote.example/objects/their-quote")).toBeNull();
    expect(queued("Reject")).not.toBeNull();
    expect(queued("Accept")).toBeNull();
  });

  it("stores the approval of our own quote and redistributes the note", async () => {
    await seedObject(REMOTE_POST, REMOTE_AUTHOR, { local: false });
    await seedObject(QUOTING_POST, AUTHOR, {
      quoteId: REMOTE_POST,
      raw: JSON.stringify({ id: QUOTING_POST, type: "Note", quote: REMOTE_POST, to: ["as:Public"] }),
    });
    const approval = "https://remote.example/quote_authorizations/abc";
    const accept = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/accept-1",
      type: "Accept",
      actor: REMOTE_AUTHOR,
      object: {
        id: "https://remote.example/activities/req-1",
        type: "QuoteRequest",
        actor: AUTHOR,
        object: REMOTE_POST,
        instrument: QUOTING_POST,
      },
      result: approval,
    };

    await processInboxActivity(accept as never, { db, baseUrl: BASE, deliveryQueue: {} } as never);

    const stored = await db
      .prepare("SELECT quote_authorization_uri FROM objects WHERE id = ?")
      .bind(QUOTING_POST)
      .first<{ quote_authorization_uri: string | null }>();
    expect(stored?.quote_authorization_uri).toBe(approval);
    // The status must not read as edited just because its quote was approved.
    const meta = await db
      .prepare("SELECT updated_at, published FROM objects WHERE id = ?")
      .bind(QUOTING_POST)
      .first<{ updated_at: string; published: string }>();
    expect(meta!.updated_at).toBe(meta!.published);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM object_edits WHERE object_id = ?").bind(QUOTING_POST).first<{ n: number }>()
    ).toEqual({ n: 0 });

    // The followers get the note with the authorization attached.
    const update = queued("Update");
    expect(update).not.toBeNull();
    const note = update!.object as Record<string, unknown>;
    expect(note.quoteAuthorization).toBe(approval);
    expect((note["@context"] as unknown[]).some((c) => typeof c === "object" && c && "quoteAuthorization" in (c as object))).toBe(true);
  });

  it("re-asks the quoted server when the authorization never arrived", async () => {
    const { retryPendingQuoteRequests } = await import("@/lib/activitypub/quotes");
    await db.prepare("UPDATE actors SET inbox = ? WHERE id = ?").bind("https://remote.example/inbox", REMOTE_AUTHOR).run();
    await seedObject(REMOTE_POST, REMOTE_AUTHOR, { local: false });
    await seedObject(QUOTING_POST, AUTHOR, { quoteId: REMOTE_POST, raw: JSON.stringify({ quote: REMOTE_POST }) });
    // The retry only looks at recent posts; older ones are left alone.
    await db.prepare("UPDATE objects SET published = datetime('now') WHERE id = ?").bind(QUOTING_POST).run();

    const sent = await retryPendingQuoteRequests({ DB: db, DELIVERY_QUEUE: null, KV: env.KV, INSTANCE_URL: BASE });
    expect(sent).toBe(1);
    const request = queued("QuoteRequest");
    expect(request).not.toBeNull();
    expect(request!.object).toBe(REMOTE_POST);
    expect(request!.instrument).toBe(QUOTING_POST);

    // Throttled: the same status is not re-asked on the next tick.
    queueMocks.enqueueDeliveries.mockClear();
    expect(await retryPendingQuoteRequests({ DB: db, DELIVERY_QUEUE: null, KV: env.KV, INSTANCE_URL: BASE })).toBe(0);
    expect(queued("QuoteRequest")).toBeNull();
  });

  it("ignores an approval that comes from another host", async () => {
    await seedObject(REMOTE_POST, REMOTE_AUTHOR, { local: false });
    await seedObject(QUOTING_POST, AUTHOR, { quoteId: REMOTE_POST, raw: JSON.stringify({ quote: REMOTE_POST }) });

    await processInboxActivity(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/activities/accept-2",
        type: "Accept",
        actor: REMOTE_AUTHOR,
        object: { id: "https://remote.example/activities/req-1", type: "QuoteRequest", object: REMOTE_POST, instrument: QUOTING_POST },
        result: "https://attacker.example/quote_authorizations/abc",
      } as never,
      { db, baseUrl: BASE } as never
    );

    const stored = await db
      .prepare("SELECT quote_authorization_uri FROM objects WHERE id = ?")
      .bind(QUOTING_POST)
      .first<{ quote_authorization_uri: string | null }>();
    expect(stored?.quote_authorization_uri).toBeNull();
  });
});
