import { beforeAll, describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

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

import { processInboxActivity } from "@/lib/activitypub/inbox";
import { getObjectById, getAttachmentsByObjectId } from "@/lib/db";

const BASE = "https://local.example.test";
const LOCAL_ACTOR = `${BASE}/users/alice`;
const LOCAL_NOTE = `${BASE}/objects/local-media-only`;
const ATTACKER = "https://evil.example/users/attacker";
const AUTHOR = "https://mastodon.example/users/author";
const REMOTE_NOTE = "https://mastodon.example/users/author/statuses/1";

const db = env.DB;

async function seedActor(id: string, local: boolean): Promise<void> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES (?, ?, ?, 'k', ?, ?)`
    )
    .bind(id, username, new URL(id).hostname, local ? "priv" : null, local ? 1 : 0)
    .run();
}

/** A local media-only post: legitimately empty content, the forgery target. */
async function seedLocalMediaOnlyNote(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, raw, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, NULL, '{"original":true}', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
    )
    .bind(LOCAL_NOTE, LOCAL_ACTOR)
    .run();
}

/** A remote note cached without content (e.g. a content-less fetch response). */
async function seedRemotePlaceholder(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects (id, type, actor_id, content, raw, visibility, published, updated_at, is_local)
       VALUES (?, 'Note', ?, NULL, '{"placeholder":true}', 'public', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 0)`
    )
    .bind(REMOTE_NOTE, AUTHOR)
    .run();
}

let activitySeq = 0;
function makeAnnounce(signer: string, object: Record<string, unknown>) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${signer}/activities/announce-${++activitySeq}`,
    type: "Announce",
    actor: signer,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${signer}/followers`],
    object,
  };
}

const ctx = () => ({ db, baseUrl: BASE }) as never;

beforeEach(async () => {
  await resetTestDatabase();
  await seedActor(LOCAL_ACTOR, true);
  await seedActor(ATTACKER, false);
  await seedActor(AUTHOR, false);
});

describe("persistRemoteNote ownership guards", () => {
  it("never rewrites a local object from an embedded note without attributedTo", async () => {
    await seedLocalMediaOnlyNote();
    await processInboxActivity(
      makeAnnounce(ATTACKER, {
        id: LOCAL_NOTE,
        type: "Note",
        content: "<p>hacked</p>",
        attachment: [{ type: "Document", mediaType: "image/png", url: "https://evil.example/x.png" }],
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2026-10-02T10:00:00Z",
      }) as never,
      ctx()
    );

    const obj = await getObjectById(db, LOCAL_NOTE);
    expect(obj).not.toBeNull();
    expect(obj!.content).toBeNull();
    expect(obj!.raw).toBe('{"original":true}');
    expect(await getAttachmentsByObjectId(db, LOCAL_NOTE)).toHaveLength(0);
  });

  it("never stores an embedded note that squats a local IRI under a remote author", async () => {
    await processInboxActivity(
      makeAnnounce(ATTACKER, {
        id: `${BASE}/objects/ghost`,
        type: "Note",
        attributedTo: ATTACKER,
        content: "<p>ghost</p>",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2026-10-02T10:00:00Z",
      }) as never,
      ctx()
    );
    expect(await getObjectById(db, `${BASE}/objects/ghost`)).toBeNull();
  });

  it("never accepts a local actor as the author of an inbox-embedded note", async () => {
    await processInboxActivity(
      makeAnnounce(ATTACKER, {
        id: "https://evil.example/objects/fake",
        type: "Note",
        attributedTo: LOCAL_ACTOR,
        content: "<p>forged as local</p>",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2026-10-02T10:00:00Z",
      }) as never,
      ctx()
    );
    expect(await getObjectById(db, "https://evil.example/objects/fake")).toBeNull();
  });

  it("does not let a third-party boost forge the content of a stored remote note", async () => {
    await seedRemotePlaceholder();
    await processInboxActivity(
      makeAnnounce(ATTACKER, {
        id: REMOTE_NOTE,
        type: "Note",
        attributedTo: AUTHOR,
        content: "<p>forged by the booster</p>",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2026-10-02T10:00:00Z",
      }) as never,
      ctx()
    );

    const obj = await getObjectById(db, REMOTE_NOTE);
    expect(obj!.content).toBeNull();
    expect(obj!.raw).toBe('{"placeholder":true}');
  });

  it("lets the author's own server fill an empty-content placeholder", async () => {
    await seedRemotePlaceholder();
    await processInboxActivity(
      makeAnnounce(AUTHOR, {
        id: REMOTE_NOTE,
        type: "Note",
        attributedTo: AUTHOR,
        content: "<p>the real text</p>",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2026-10-02T10:00:00Z",
      }) as never,
      ctx()
    );

    const obj = await getObjectById(db, REMOTE_NOTE);
    expect(obj!.content).toContain("the real text");
    expect(obj!.actorId).toBe(AUTHOR);
  });

  it("still stores an unknown remote note embedded in a third-party boost", async () => {
    await processInboxActivity(
      makeAnnounce(ATTACKER, {
        id: REMOTE_NOTE,
        type: "Note",
        attributedTo: AUTHOR,
        content: "<p>hello federation</p>",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2026-10-02T10:00:00Z",
      }) as never,
      ctx()
    );

    const obj = await getObjectById(db, REMOTE_NOTE);
    expect(obj).not.toBeNull();
    expect(obj!.actorId).toBe(AUTHOR);
    expect(obj!.local).toBe(false);
    expect(obj!.content).toContain("hello federation");
  });
});

describe("handleAnnounce visibility gate", () => {
  async function seedLocalObject(id: string, visibility: string): Promise<void> {
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, raw, visibility, published, updated_at, is_local)
         VALUES (?, 'Note', ?, '<p>local</p>', '{}', ?, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', 1)`
      )
      .bind(id, LOCAL_ACTOR, visibility)
      .run();
  }

  async function announceCount(objectId: string): Promise<number> {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM announces WHERE object_id = ?")
      .bind(objectId)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  it("never stores a boost of a direct message (no counter, no notification)", async () => {
    const dmId = `${BASE}/objects/dm-1`;
    await seedLocalObject(dmId, "direct");
    await processInboxActivity(
      makeAnnounce(ATTACKER, {
        id: dmId,
        type: "Note",
        attributedTo: LOCAL_ACTOR,
        content: "<p>local</p>",
        to: [LOCAL_ACTOR],
        published: "2026-10-01T10:00:00Z",
      }) as never,
      ctx()
    );
    expect(await announceCount(dmId)).toBe(0);
    const obj = await getObjectById(db, dmId);
    expect(obj?.reblogsCount).toBe(0);
  });

  it("never stores a third-party boost of a followers-only post", async () => {
    const privId = `${BASE}/objects/priv-1`;
    await seedLocalObject(privId, "private");
    await processInboxActivity(
      makeAnnounce(ATTACKER, {
        id: privId,
        type: "Note",
        attributedTo: LOCAL_ACTOR,
        content: "<p>local</p>",
        to: [`${LOCAL_ACTOR}/followers`],
        published: "2026-10-01T10:00:00Z",
      }) as never,
      ctx()
    );
    expect(await announceCount(privId)).toBe(0);
  });

  it("stores a normal boost of a public post", async () => {
    const pubId = `${BASE}/objects/pub-1`;
    await seedLocalObject(pubId, "public");
    await processInboxActivity(
      makeAnnounce(ATTACKER, {
        id: pubId,
        type: "Note",
        attributedTo: LOCAL_ACTOR,
        content: "<p>local</p>",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        published: "2026-10-01T10:00:00Z",
      }) as never,
      ctx()
    );
    expect(await announceCount(pubId)).toBe(1);
  });
});
