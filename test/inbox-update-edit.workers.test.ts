import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

const federation = vi.hoisted(() => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
  safeFetch: vi.fn(),
  validateOutboundUrl: vi.fn(() => ({ valid: true })),
}));
vi.mock("@/lib/activitypub/federation", () => federation);

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
  broadcastStatusUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastStatusCreatedToAudience: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/push", () => ({ deliverPushSafe: vi.fn().mockResolvedValue(undefined) }));

const remote = vi.hoisted(() => ({ fetchAndCacheRemoteStatus: vi.fn(async () => ({ object: null, actor: null })) }));
vi.mock("@/lib/activitypub/remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/remote")>()),
  fetchAndCacheRemoteStatus: remote.fetchAndCacheRemoteStatus,
}));

import { processInboxActivity } from "@/lib/activitypub/inbox";
import { createObject } from "@/lib/db";

const db = env.DB;
const BASE = "https://local.example.test";
const AUTHOR = "https://remote.example/users/ana";
const NOTE = "https://remote.example/users/ana/statuses/1";
const QUOTED = "https://quoted.example/users/bob/statuses/9";
const LOCAL_ACTOR = `${BASE}/users/me`;
const LOCAL_NOTE_UUID = "11111111-2222-4333-8444-555555555555";
const LOCAL_NOTE = `${BASE}/objects/${LOCAL_NOTE_UUID}`;

interface StoredRow {
  content: string | null;
  published: string;
  updated_at: string;
  raw: string;
  quote_authorization_uri: string | null;
}

async function stored(): Promise<StoredRow | null> {
  return db
    .prepare("SELECT content, published, updated_at, raw, quote_authorization_uri FROM objects WHERE id = ?")
    .bind(NOTE)
    .first<StoredRow>();
}

async function editRows(): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM object_edits WHERE object_id = ?")
    .bind(NOTE)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** An `Update{Note}` from the author, like the one a quote authorization sends. */
async function sendUpdate(overrides: Record<string, unknown> = {}): Promise<void> {
  await processInboxActivity(
    {
      id: `${AUTHOR}#updates/${Math.random().toString(36).slice(2, 8)}`,
      type: "Update",
      actor: AUTHOR,
      object: {
        id: NOTE,
        type: "Note",
        attributedTo: AUTHOR,
        content: "<p>hola</p>",
        published: "2026-10-22T10:00:00.000Z",
        to: ["https://www.w3.org/ns/ActivityStreams#Public"],
        cc: [],
        updated: new Date().toISOString(),
        ...overrides,
      },
    } as never,
    { db, baseUrl: BASE } as never
  );
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, 'ana', 'remote.example', 'k', 0)")
    .bind(AUTHOR)
    .run();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable)
       VALUES (?, 'me', 'local.example.test', 'pub', 'priv', 1, 1)`
    )
    .bind(LOCAL_ACTOR)
    .run();
  await createObject(db, {
    id: LOCAL_NOTE,
    type: "Note",
    actorId: LOCAL_ACTOR,
    content: "<p>nota local</p>",
    contentWarning: null,
    sensitive: false,
    visibility: "public",
    inReplyToId: null,
    quoteId: null,
    language: null,
    url: LOCAL_NOTE,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-10-22T10:00:00.000Z",
    local: true,
    raw: JSON.stringify({ id: LOCAL_NOTE, type: "Note", content: "<p>nota local</p>" }),
  });
  await createObject(db, {
    id: NOTE,
    type: "Note",
    actorId: AUTHOR,
    content: "<p>hola</p>",
    contentWarning: null,
    sensitive: false,
    visibility: "public",
    inReplyToId: null,
    quoteId: null,
    language: null,
    url: NOTE,
    repliesCount: 0,
    reblogsCount: 0,
    favouritesCount: 0,
    published: "2026-10-22T10:00:00.000Z",
    local: false,
    raw: JSON.stringify({ id: NOTE, type: "Note", content: "<p>hola</p>" }),
  });
});

describe("an Update that changes nothing", () => {
  it("does not mark the status as edited", async () => {
    const before = await stored();

    await sendUpdate();

    const after = await stored();
    // The row's `updated_at` is what every client reads as "edited".
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(after?.content).toBe("<p>hola</p>");
    // …and no empty edit-history row is recorded.
    expect(await editRows()).toBe(0);
  });

  it("refreshes the stored document (serializers read it) and the quote authorization", async () => {
    await sendUpdate({
      quote: QUOTED,
      quoteAuthorization: "https://quoted.example/quote_authorizations/abc",
    });

    const after = await stored();
    // A fresh row stores `updated_at = published`; an Update that changes
    // nothing must leave that pair alone (it is what `editedAtIso` keys off).
    expect(after?.updated_at).toBe(after?.published);
    const raw = JSON.parse(after?.raw ?? "{}") as Record<string, unknown>;
    expect(raw.quoteAuthorization).toBe("https://quoted.example/quote_authorizations/abc");
    expect(after?.quote_authorization_uri).toBe("https://quoted.example/quote_authorizations/abc");
  });

  it("ignores an authorization that does not come from the quoted server", async () => {
    await sendUpdate({
      quote: QUOTED,
      quoteAuthorization: "https://attacker.example/quote_authorizations/xyz",
    });

    const after = await stored();
    expect(after?.quote_authorization_uri).toBeNull();
  });
});

describe("a real edit", () => {
  it("stamps updated_at and records the previous version", async () => {
    const before = await stored();
    await sendUpdate({ content: "<p>hola editado</p>" });

    const after = await stored();
    expect(after?.content).toBe("<p>hola editado</p>");
    expect(after?.updated_at).not.toBe(before?.updated_at);
    expect(after?.updated_at).not.toBe(after?.published);
    expect(await editRows()).toBe(1);
  });
});

describe("an Update that adds a quote", () => {
  it("stores the quote without stamping edited_at, and fetches the quoted post", async () => {
    const before = await stored();

    await sendUpdate({
      quote: QUOTED,
      quoteAuthorization: "https://quoted.example/quote_authorizations/abc",
    });

    const after = await stored();
    // The quote is what the peers render the card from; it used to stay NULL
    // when it only arrived with the Update (the redistribution).
    const quoteRow = await db
      .prepare("SELECT quote_id FROM objects WHERE id = ?")
      .bind(NOTE)
      .first<{ quote_id: string | null }>();
    expect(quoteRow?.quote_id).toBe(QUOTED);
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(await editRows()).toBe(0);
    // The quoted post is fetched so the card can render here too.
    expect(remote.fetchAndCacheRemoteStatus).toHaveBeenCalledWith(db, QUOTED);
  });
});

describe("the served document", () => {
  const fetchNote = async (): Promise<{ updated?: string; published?: string }> => {
    const { GET } = await import("@/app/objects/[id]/route");
    const response = await GET(
      new Request(`${BASE}/objects/${LOCAL_NOTE_UUID}`, { headers: { Accept: "application/activity+json" } } as never) as never,
      { params: Promise.resolve({ id: LOCAL_NOTE_UUID }) } as never
    );
    return (await response.json()) as { updated?: string; published?: string };
  };

  it("carries `updated` only once the status was edited", async () => {
    // A local status (the object endpoint serves local notes) never edited:
    // `updated_at` equals `published`, so nothing to report.
    await env.KV.delete(`ap:obj:${LOCAL_NOTE_UUID}`);
    expect((await fetchNote()).updated).toBeUndefined();

    // The author edits it (the API stamps `updated_at` past `published`).
    await db
      .prepare("UPDATE objects SET content = '<p>nota local editada</p>', updated_at = datetime('now') WHERE id = ?")
      .bind(LOCAL_NOTE)
      .run();
    await env.KV.delete(`ap:obj:${LOCAL_NOTE_UUID}`);

    const edited = await fetchNote();
    expect(edited.updated).toBeDefined();
    expect(Number.isFinite(Date.parse(edited.updated ?? ""))).toBe(true);
  });
});
