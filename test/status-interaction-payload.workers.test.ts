import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const broadcastMocks = vi.hoisted(() => ({
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastStatusInteractionToLists: vi.fn().mockResolvedValue(undefined),
  broadcastStatusCreatedToAudience: vi.fn().mockResolvedValue(undefined),
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
}));

vi.mock("@/lib/streaming/broadcast", () => broadcastMocks);

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/queue", () => ({
  enqueueDeliveries: vi.fn().mockResolvedValue(undefined),
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/federation", () => ({
  collectFollowerInboxes: vi.fn().mockResolvedValue([]),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
}));

import { POST as favourite } from "@/app/api/v1/statuses/[id]/favourite/route";
import { POST as unfavourite } from "@/app/api/v1/statuses/[id]/unfavourite/route";
import { createAttachment, createPoll } from "@/lib/db";
import { encodeStatusId } from "@/lib/mastodon/statusId";

const db = env.DB;
const BASE = "https://local.example.test";
const ME = `${BASE}/users/me`;
const AUTHOR = "https://other.example/users/author";
const NOTE = "https://other.example/objects/n1";
const QUOTED = "https://other.example/objects/quoted";
const ATT = "https://other.example/media/pic.jpg";
const TOKEN = "interaction-token";

interface SerializedStatus {
  uri: string;
  media_attachments: { url: string }[];
  poll: { id: string } | null;
  quote: { uri: string } | null;
  quotes_count: number;
  favourited: boolean;
  reblogged: boolean;
  bookmarked: boolean;
  pinned: boolean;
}

function request(path: string): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  broadcastMocks.broadcastStatusInteraction.mockClear();
  broadcastMocks.broadcastStatusInteractionToLists.mockClear();

  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email_verified) VALUES (?,?,?,'k','pk',1,1)")
    .bind(ME, "me", "local.example.test")
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,'k',0)")
    .bind(AUTHOR, "author", "other.example")
    .run();
  await db
    .prepare(
      "INSERT INTO objects (id, type, actor_id, content, visibility, published, is_local, media_pending) VALUES (?, 'Note', ?, '<p>con cita</p>', 'public', '2026-10-07T10:00:00Z', 0, 0)"
    )
    .bind(NOTE, AUTHOR)
    .run();
  await db.prepare("UPDATE objects SET quote_id = ? WHERE id = ?").bind(QUOTED, NOTE).run();
  await db
    .prepare(
      "INSERT INTO objects (id, type, actor_id, content, visibility, published, is_local, media_pending) VALUES (?, 'Note', ?, '<p>la cita</p>', 'public', '2026-10-07T09:00:00Z', 0, 0)"
    )
    .bind(QUOTED, AUTHOR)
    .run();
  await createAttachment(db, {
    id: "att-1",
    objectId: NOTE,
    type: "image",
    url: ATT,
    remoteUrl: ATT,
    description: null,
    blurhash: null,
    width: 1200,
    height: 800,
    fileSize: null,
    mimeType: "image/jpeg",
    sensitive: false,
    createdAt: "2026-10-07T10:00:00Z",
  });
  await createPoll(db, {
    id: "poll-1",
    objectId: NOTE,
    expiresAt: "2026-12-31T00:00:00Z",
    multiple: false,
    options: [
      { id: "opt-1", title: "A", position: 0 },
      { id: "opt-2", title: "B", position: 1 },
    ],
  });
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, access_token, refresh_token, scope, expires_at, created_at) VALUES ('t1', ?, ?, 'r1', 'read write', '2099-01-01T00:00:00Z', datetime('now'))"
    )
    .bind(ME, TOKEN)
    .run();
});

describe("status interaction payloads", () => {
  it("keeps the quote, media and poll in the favourite response and broadcast", async () => {
    const res = await favourite(request(`/api/v1/statuses/x/favourite`) as never, {
      params: Promise.resolve({ id: encodeStatusId(NOTE, false) }),
    } as never);
    expect(res.status).toBe(200);

    const body = await res.json() as SerializedStatus;
    expect(body.favourited).toBe(true);
    expect(body.media_attachments.map((a) => a.url)).toEqual([ATT]);
    expect(body.poll?.id).toBe("poll-1");
    expect(body.quote?.uri).toBe(QUOTED);

    // The streamed status.update must carry the same complete payload: the
    // client replaces its cached copy with it.
    const broadcast = broadcastMocks.broadcastStatusInteraction.mock.calls[0]?.[1] as SerializedStatus | undefined;
    expect(broadcast).toBeTruthy();
    expect(broadcast!.media_attachments.map((a) => a.url)).toEqual([ATT]);
    expect(broadcast!.poll?.id).toBe("poll-1");
    expect(broadcast!.quote?.uri).toBe(QUOTED);
  });

  it("does not clear other viewer fields when unfavouriting", async () => {
    await db.prepare("INSERT INTO bookmarks (id, actor_id, object_id) VALUES ('bm1', ?, ?)").bind(ME, NOTE).run();
    await db.prepare("INSERT INTO likes (id, actor_id, object_id) VALUES ('lk1', ?, ?)").bind(ME, NOTE).run();

    const res = await unfavourite(request(`/api/v1/statuses/x/unfavourite`) as never, {
      params: Promise.resolve({ id: encodeStatusId(NOTE, false) }),
    } as never);
    expect(res.status).toBe(200);

    const body = await res.json() as SerializedStatus;
    expect(body.favourited).toBe(false);
    // The bookmark (and the rest of the viewer state) survives the response.
    expect(body.bookmarked).toBe(true);
    expect(body.quote?.uri).toBe(QUOTED);
  });
});
