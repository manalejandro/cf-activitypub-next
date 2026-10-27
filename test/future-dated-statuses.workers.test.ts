import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const broadcast = vi.hoisted(() => ({
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastAccountUpdate: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: broadcast.broadcastPublicStatus,
  broadcastHomeStatus: broadcast.broadcastHomeStatus,
  broadcastBoost: vi.fn().mockResolvedValue(undefined),
  broadcastNewBoost: vi.fn().mockResolvedValue(undefined),
  broadcastNewBoostToFollowers: vi.fn().mockResolvedValue(undefined),
  broadcastRemoteStatusRefresh: vi.fn().mockResolvedValue(undefined),
  broadcastStatusCreatedToAudience: vi.fn().mockResolvedValue(undefined),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
  broadcastObjectDelete: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusRefresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

const federation = vi.hoisted(() => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
  safeFetch: vi.fn(),
  validateOutboundUrl: vi.fn(() => ({ valid: true })),
}));
vi.mock("@/lib/activitypub/federation", () => federation);

import { processInboxActivity } from "@/lib/activitypub/inbox";
import {
  createObject,
  getHomeTimeline,
  getHashtagTimeline,
  getActorStatuses,
  getPublicTimeline,
  getObjectById,
} from "@/lib/db";
import { isPublishedInFuture } from "@/lib/dates";
import { GET as PUBLIC_TIMELINE } from "@/app/api/v1/timelines/public/route";

const db = env.DB;
const BASE = "https://local.example.test";
const ME = `${BASE}/users/me`;
const REMOTE = "https://tupodcast.example/users/flash";

const HOURS = 3600 * 1000;
const futureIso = () => new Date(Date.now() + 2 * HOURS).toISOString();
const pastIso = () => new Date(Date.now() - 1 * HOURS).toISOString();

function fakeStream() {
  return { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("ok") }) };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  vi.mocked(broadcast.broadcastPublicStatus).mockClear();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, 'me', 'local.example.test', 'pub', 'priv', 1)`
    )
    .bind(ME)
    .run();
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, is_local)
       VALUES (?, 'flash', 'tupodcast.example', 'pub', 0)`
    )
    .bind(REMOTE)
    .run();
});

async function lastStatusAt(actorId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT last_status_at AS d FROM actors WHERE id = ?")
    .bind(actorId)
    .first<{ d: string | null }>();
  return row?.d ?? null;
}

async function seedStatus(id: string, published: string, opts: { tag?: string } = {}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, raw, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, '<p>hola</p>', '{}', 'public', ?, ?, 0)`
    )
    .bind(id, REMOTE, published, published)
    .run();
  if (opts.tag) {
    await db
      .prepare("INSERT INTO object_tags (object_id, tag, published, actor_id) VALUES (?, ?, ?, ?)")
      .bind(id, opts.tag, published, REMOTE)
      .run();
  }
}

describe("isPublishedInFuture", () => {
  it("detects future instants and fails open on garbage", () => {
    expect(isPublishedInFuture(futureIso())).toBe(true);
    expect(isPublishedInFuture(pastIso())).toBe(false);
    expect(isPublishedInFuture("2026-10-01 10:00:00")).toBe(false); // legacy db shape, past
    expect(isPublishedInFuture("no es una fecha")).toBe(false);
    expect(isPublishedInFuture(null)).toBe(false);
  });
});

describe("future-dated statuses are hidden until due", () => {
  const FUTURE_ID = "https://tupodcast.example/users/flash/notes/future";
  const PAST_ID = "https://tupodcast.example/users/flash/notes/past";

  beforeEach(async () => {
    await seedStatus(FUTURE_ID, futureIso(), { tag: "podcast" });
    await seedStatus(PAST_ID, pastIso(), { tag: "podcast" });
  });

  it("hides them from the public timeline (db + REST route)", async () => {
    const entries = await getPublicTimeline(db, 20);
    expect(entries.map((o) => o.id)).toEqual([PAST_ID]);

    const res = await PUBLIC_TIMELINE(new NextRequest(`${BASE}/api/v1/timelines/public`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; uri?: string; url?: string }[];
    expect(body).toHaveLength(1);
  });

  it("hides them from the home timeline of a follower", async () => {
    await db
      .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
      .bind(ME, REMOTE)
      .run();
    const entries = await getHomeTimeline(db, ME, 20);
    expect(entries.map((e) => e.object.id)).toEqual([PAST_ID]);
  });

  it("hides them from the author's profile timeline", async () => {
    const entries = await getActorStatuses(db, REMOTE, 20);
    expect(entries.map((e) => e.object.id)).toEqual([PAST_ID]);
  });

  it("hides them from the hashtag timeline", async () => {
    const entries = await getHashtagTimeline(db, "podcast", 20);
    expect(entries.map((o) => o.id)).toEqual([PAST_ID]);
  });

  it("keeps them stored (they appear when their instant arrives)", async () => {
    const stored = await getObjectById(db, FUTURE_ID);
    expect(stored).not.toBeNull();
    // Simulate the instant passing: the same query now returns both.
    await db
      .prepare("UPDATE objects SET published = ?, updated_at = ? WHERE id = ?")
      .bind(pastIso(), pastIso(), FUTURE_ID)
      .run();
    const entries = await getPublicTimeline(db, 20);
    expect(entries.map((o) => o.id)).toEqual(expect.arrayContaining([FUTURE_ID, PAST_ID]));
  });
});

describe("future-dated inbound Create", () => {
  function makeCreate(published: string, idSuffix: string) {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${REMOTE}/activities/create-${idSuffix}`,
      type: "Create",
      actor: REMOTE,
      published,
      object: {
        id: `${REMOTE}/notes/${idSuffix}`,
        type: "Note",
        attributedTo: REMOTE,
        content: "<p>desde el futuro</p>",
        published,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
      },
    };
  }

  it("stores the status but never streams it", async () => {
    await processInboxActivity(makeCreate(futureIso(), "f1") as never, {
      db,
      baseUrl: BASE,
      timelineStream: fakeStream(),
    } as never);

    const stored = await getObjectById(db, `${REMOTE}/notes/f1`);
    expect(stored).not.toBeNull();
    expect(isPublishedInFuture(stored!.published)).toBe(true);
    expect(broadcast.broadcastPublicStatus).not.toHaveBeenCalled();
    // …and it is not on the timeline either.
    expect(await getPublicTimeline(db, 20)).toHaveLength(0);
    // Nor did it push the author's directory rank into the future.
    expect(await lastStatusAt(REMOTE)).toBeFalsy();
  });

  it("streams a normally-dated status as before", async () => {
    await processInboxActivity(makeCreate(pastIso(), "p1") as never, {
      db,
      baseUrl: BASE,
      timelineStream: fakeStream(),
    } as never);

    expect(await getObjectById(db, `${REMOTE}/notes/p1`)).not.toBeNull();
    expect(broadcast.broadcastPublicStatus).toHaveBeenCalled();
    expect(await lastStatusAt(REMOTE)).toBeTruthy();
  });
});

describe("createObject directory rank", () => {
  it("does not advance last_status_at for a future-dated public post", async () => {
    await createObject(db, {
      id: `${REMOTE}/notes/future-direct`,
      type: "Note",
      actorId: REMOTE,
      content: "<p>x</p>",
      contentWarning: null,
      sensitive: false,
      visibility: "public",
      inReplyToId: null,
      quoteId: null,
      language: null,
      url: `${REMOTE}/notes/future-direct`,
      repliesCount: 0,
      reblogsCount: 0,
      favouritesCount: 0,
      published: futureIso(),
      local: false,
      raw: "{}",
    });
    expect(await lastStatusAt(REMOTE)).toBeFalsy();

    await createObject(db, {
      id: `${REMOTE}/notes/past-direct`,
      type: "Note",
      actorId: REMOTE,
      content: "<p>x</p>",
      contentWarning: null,
      sensitive: false,
      visibility: "public",
      inReplyToId: null,
      quoteId: null,
      language: null,
      url: `${REMOTE}/notes/past-direct`,
      repliesCount: 0,
      reblogsCount: 0,
      favouritesCount: 0,
      published: pastIso(),
      local: false,
      raw: "{}",
    });
    expect(await lastStatusAt(REMOTE)).toBeTruthy();
  });
});
