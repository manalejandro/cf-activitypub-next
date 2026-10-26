import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

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
import { getActorById } from "@/lib/db";

const db = env.DB;
const BASE = "https://local.example.test";
const FAN = `${BASE}/users/fan`;
const SOURCE = "https://old.example/users/alice";
const TARGET = "https://new.example/users/alice";
const VICTIM = "https://victim.example/users/vic";

function fakeQueue() {
  const sent: { body: { inboxUrl: string; activityJson: string; actorId: string } }[] = [];
  return {
    sent,
    queue: {
      sendBatch: vi.fn(async (messages: { body: { inboxUrl: string; activityJson: string; actorId: string } }[]) => {
        sent.push(...messages);
      }),
    },
  };
}

async function seedActor(
  id: string,
  opts: { local?: boolean; alsoKnownAs?: string[] } = {}
): Promise<void> {
  const username = id.split("/").pop()!;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, inbox, also_known_as)
       VALUES (?, ?, ?, 'pub', ?, ?, ?, ?)`
    )
    .bind(
      id,
      username,
      new URL(id).hostname,
      opts.local ? "priv" : null,
      opts.local ? 1 : 0,
      `${id}/inbox`,
      opts.alsoKnownAs ? JSON.stringify(opts.alsoKnownAs) : null
    )
    .run();
}

let moveSeq = 0;
function makeMove(fields: Record<string, unknown>) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${SOURCE}/activities/move-${++moveSeq}`,
    type: "Move",
    ...fields,
  };
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  await seedActor(FAN, { local: true });
  await seedActor(SOURCE);
  await seedActor(TARGET, { alsoKnownAs: [SOURCE] });
  await seedActor(VICTIM);
  await db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES ('f1', ?, ?, 'accepted')")
    .bind(FAN, SOURCE)
    .run();
});

function ctxWith(queue: unknown) {
  return { db, baseUrl: BASE, deliveryQueue: queue } as never;
}

describe("inbound Move", () => {
  it("processes Mastodon's shape (object = origin, target = destination)", async () => {
    const { sent, queue } = fakeQueue();
    await processInboxActivity(
      makeMove({ actor: SOURCE, object: SOURCE, target: TARGET }) as never,
      ctxWith(queue)
    );

    const source = await getActorById(db, SOURCE);
    expect(source?.movedTo).toBe(TARGET);

    const oldFollow = await db
      .prepare("SELECT id FROM follows WHERE actor_id = ? AND target_id = ?")
      .bind(FAN, SOURCE)
      .first();
    expect(oldFollow).toBeNull();

    const newFollow = await db
      .prepare("SELECT state FROM follows WHERE actor_id = ? AND target_id = ?")
      .bind(FAN, TARGET)
      .first<{ state: string }>();
    expect(newFollow?.state).toBe("accepted");

    // The re-follow is delivered signed by the local follower itself.
    expect(sent.some((m) => m.body.activityJson.includes('"type":"Follow"'))).toBe(true);
  });

  it("processes the legacy shape (destination in object, no target)", async () => {
    const { queue } = fakeQueue();
    await processInboxActivity(
      makeMove({ actor: SOURCE, object: TARGET }) as never,
      ctxWith(queue)
    );
    const source = await getActorById(db, SOURCE);
    expect(source?.movedTo).toBe(TARGET);
  });

  it("refuses a Move whose object is a different account than the actor", async () => {
    const { sent, queue } = fakeQueue();
    await processInboxActivity(
      makeMove({ actor: SOURCE, object: VICTIM, target: TARGET }) as never,
      ctxWith(queue)
    );

    expect((await getActorById(db, SOURCE))?.movedTo).toBeFalsy();
    expect((await getActorById(db, VICTIM))?.movedTo).toBeFalsy();
    const follow = await db
      .prepare("SELECT id FROM follows WHERE actor_id = ? AND target_id = ?")
      .bind(FAN, SOURCE)
      .first();
    expect(follow).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("refuses a Move whose destination does not alias the origin", async () => {
    const { queue } = fakeQueue();
    await processInboxActivity(
      makeMove({ actor: SOURCE, object: SOURCE, target: VICTIM }) as never,
      ctxWith(queue)
    );
    expect((await getActorById(db, SOURCE))?.movedTo).toBeFalsy();
  });
});
