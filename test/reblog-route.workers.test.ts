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

import { POST } from "@/app/api/v1/statuses/[id]/reblog/route";
import { createAttachment } from "@/lib/db";
import { encodeStatusId } from "@/lib/mastodon/statusId";

const db = env.DB;
const BASE = "https://local.example.test";
const ME = `${BASE}/users/me`;
const AUTHOR = "https://other.example/users/author";
const NOTE = "https://other.example/objects/n1";
const ATT = "https://other.example/media/pic.jpg";
const TOKEN = "reblog-token";

interface StreamedStatus {
  uri: string;
  media_attachments: { url: string }[];
  reblog?: StreamedStatus;
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  broadcastMocks.broadcastHomeStatus.mockClear();
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
      "INSERT INTO objects (id, type, actor_id, content, visibility, published, is_local, media_pending) VALUES (?, 'Note', ?, '<p>con foto</p>', 'public', '2026-10-07T10:00:00Z', 0, 0)"
    )
    .bind(NOTE, AUTHOR)
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
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, access_token, refresh_token, scope, expires_at, created_at) VALUES ('t1', ?, ?, 'r1', 'read write', '2099-01-01T00:00:00Z', datetime('now'))"
    )
    .bind(ME, TOKEN)
    .run();
});

describe("POST /api/v1/statuses/:id/reblog", () => {
  it("returns the original with media and streams the wrapper to the booster's followers", async () => {
    const request = new Request(`${BASE}/api/v1/statuses/x/reblog`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const res = await POST(request as never, {
      params: Promise.resolve({ id: encodeStatusId(NOTE, false) }),
    } as never);
    expect(res.status).toBe(200);

    const body = await res.json() as StreamedStatus;
    expect(body.media_attachments.map((a) => a.url)).toEqual([ATT]);

    // The live wrapper must carry the media too: for followers who do not
    // follow the original author it is their first (and only) view of it.
    const wrapper = broadcastMocks.broadcastHomeStatus.mock.calls
      .map((call) => call[2] as StreamedStatus)
      .find((payload) => payload?.reblog?.uri === NOTE);
    expect(wrapper).toBeTruthy();
    expect(wrapper!.reblog!.media_attachments.map((a) => a.url)).toEqual([ATT]);
  });
});
