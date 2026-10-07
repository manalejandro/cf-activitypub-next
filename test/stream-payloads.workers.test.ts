import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

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

vi.mock("@/lib/activitypub/federation", () => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
}));

import { processInboxActivity } from "@/lib/activitypub/inbox";
import { createAttachment, createPoll } from "@/lib/db";

const db = env.DB;
const BASE = "https://local.example.test";
const ME = `${BASE}/users/me`;
const BOOSTER = "https://remote.example/users/booster";
const AUTHOR = "https://other.example/users/author";
const NOTE = "https://other.example/objects/n1";
const ATT = "https://other.example/media/pic.jpg";

interface StreamedStatus {
  id: string;
  uri: string;
  media_attachments: { url: string }[];
  poll: { id: string } | null;
  reblog?: StreamedStatus;
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestDatabase();
  broadcastMocks.broadcastHomeStatus.mockClear();
  broadcastMocks.broadcastPublicStatus.mockClear();
  broadcastMocks.broadcastStatusInteraction.mockClear();
  broadcastMocks.broadcastStatusInteractionToLists.mockClear();

  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local, email_verified) VALUES (?,?,?,'k',1,1)")
    .bind(ME, "me", "local.example.test")
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,'k',0)")
    .bind(BOOSTER, "booster", "remote.example")
    .run();
  await db
    .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,'k',0)")
    .bind(AUTHOR, "author", "other.example")
    .run();
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
    .bind(ME, BOOSTER)
    .run();
  await db
    .prepare(
      "INSERT INTO objects (id, type, actor_id, content, visibility, published, is_local, media_pending) VALUES (?, 'Note', ?, '<p>hola</p>', 'public', '2026-10-07T10:00:00Z', 0, 0)"
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
});

async function announce() {
  await processInboxActivity(
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/ann1",
      type: "Announce",
      actor: BOOSTER,
      object: NOTE,
    } as never,
    { db, kv: env.KV, baseUrl: BASE, signingActorId: BOOSTER, timelineStream: {} } as never
  );
}

describe("boost streaming payloads", () => {
  it("keeps the original's media and poll in the status.update refresh", async () => {
    await announce();

    // The refresh is emitted before the boost itself: clients replace their
    // cached copy with this payload, so a bare status wiped the images of an
    // already-rendered post the moment it was boosted.
    const refreshed = broadcastMocks.broadcastStatusInteraction.mock.calls[0]?.[1] as StreamedStatus | undefined;
    expect(refreshed).toBeTruthy();
    expect(refreshed!.media_attachments.map((a) => a.url)).toEqual([ATT]);
    expect(refreshed!.poll?.id).toBe("poll-1");
  });

  it("streams the boost with the original's media and poll", async () => {
    await announce();

    const wrapper = broadcastMocks.broadcastHomeStatus.mock.calls
      .map((call) => call[2] as StreamedStatus)
      .find((payload) => payload?.reblog?.uri === NOTE);
    expect(wrapper).toBeTruthy();
    expect(wrapper!.reblog!.media_attachments.map((a) => a.url)).toEqual([ATT]);
    expect(wrapper!.reblog!.poll?.id).toBe("poll-1");
  });

  it("does not stream a status held while its remote media is cached", async () => {
    const HELD = "https://other.example/objects/held";
    await processInboxActivity(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://other.example/activities/c1",
        type: "Create",
        actor: AUTHOR,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        object: {
          id: HELD,
          type: "Note",
          attributedTo: AUTHOR,
          content: "<p>con foto</p>",
          attachment: [{ type: "Document", mediaType: "image/jpeg", url: "https://other.example/media/held.jpg" }],
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          published: "2026-10-07T11:00:00Z",
        },
      } as never,
      { db, kv: env.KV, baseUrl: BASE, signingActorId: AUTHOR, timelineStream: {} } as never
    );

    const row = await db
      .prepare("SELECT media_pending FROM objects WHERE id = ?")
      .bind(HELD)
      .first<{ media_pending: number }>();
    expect(row?.media_pending).toBe(1);
    // Held statuses never reach clients (they would carry origin URLs); the
    // cron announces them with the cached copies once released.
    expect(broadcastMocks.broadcastPublicStatus).not.toHaveBeenCalled();
    expect(broadcastMocks.broadcastHomeStatus).not.toHaveBeenCalled();
  });
});
