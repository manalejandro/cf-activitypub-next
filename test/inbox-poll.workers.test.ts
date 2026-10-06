import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { getPollByObjectId, getPollOptions, getObjectById, getPollsByObjectIds } from "@/lib/db";
import { broadcastPublicStatus } from "@/lib/streaming/broadcast";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  // Recipient filtering is covered by streaming-recipients.workers.test.ts;
  // here every follower stays eligible.
  eligibleLocalRecipients: vi.fn(async (_db: unknown, ids: string[]) => ids),
  actorExclusion: vi.fn(async (_db: unknown, id: string) => ({ id, domain: null })),
  parentExclusion: vi.fn(async () => null),
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/federation", () => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  signedGetHeaders: vi.fn().mockResolvedValue({}),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
}));

const db = env.DB;
let BASE: string;

const ACTOR_ID = "https://remote.example/users/alice";

const QUESTION_ID = "https://remote.example/objects/q1";function makeQuestionActivity() {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: "https://remote.example/activities/create-q1",
    type: "Create",
    actor: ACTOR_ID,
    published: "2026-01-01T00:00:00Z",
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: ["https://remote.example/users/alice/followers"],
    object: {
      id: QUESTION_ID,
      type: "Question",
      attributedTo: ACTOR_ID,
      content: "<p>¿Cuál es tu color favorito?</p>",
      oneOf: [
        { type: "Note", name: "Rojo" },
        { type: "Note", name: "Azul" },
        { type: "Note", name: "Verde" },
      ],
      endTime: "2026-02-01T00:00:00Z",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: ["https://remote.example/users/alice/followers"],
      published: "2026-01-01T00:00:00Z",
    },
  };
}

beforeAll(async () => {
  BASE = "https://local.example.test";
});

async function freshDb() {
  await resetTestDatabase();
  await db
    .prepare(
      "INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(ACTOR_ID, "alice", "remote.example", "test-key", 0)
    .run();
}

describe("federated poll ingestion (Create Question)", () => {
  beforeEach(async () => {
    await freshDb();
    vi.mocked(broadcastPublicStatus).mockClear();
  });

  it("stores the poll row + option rows so timelines can render voting options", async () => {
    await processInboxActivity(makeQuestionActivity() as never, { db, baseUrl: BASE } as never);

    const obj = await getObjectById(db, QUESTION_ID);
    expect(obj).not.toBeNull();
    expect(obj?.type).toBe("Question");

    const poll = await getPollByObjectId(db, QUESTION_ID);
    expect(poll).not.toBeNull();
    expect(poll?.multiple).toBe(false);

    const options = poll ? await getPollOptions(db, poll.id) : [];
    expect(options.map((o) => o.title)).toEqual(["Rojo", "Azul", "Verde"]);

    const map = await getPollsByObjectIds(db, [QUESTION_ID]);
    const entry = map.get(QUESTION_ID);
    expect(entry).toBeDefined();
    expect(entry?.options).toHaveLength(3);
  });

  it("broadcasts the status to the public timeline WITH poll data", async () => {
    const fakeStream = {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => new Response("ok") }),
    };
    await processInboxActivity(makeQuestionActivity() as never, {
      db,
      baseUrl: BASE,
      timelineStream: fakeStream as never,
    } as never);

    expect(broadcastPublicStatus).toHaveBeenCalledTimes(1);
    const [, status] = vi.mocked(broadcastPublicStatus).mock.calls[0] as unknown as [unknown, { poll: { options: { title: string }[] } | null }, boolean];
    expect(status.poll).not.toBeNull();
    expect(status.poll?.options.map((o) => o.title)).toEqual(["Rojo", "Azul", "Verde"]);
  });
});

describe("poll vote updates (Update{Question})", () => {
  beforeEach(async () => {
    await freshDb();
  });

  function questionDocument(content: string, counts: number[]) {
    return {
      id: QUESTION_ID,
      type: "Question",
      attributedTo: ACTOR_ID,
      content,
      updated: new Date(Date.now() + 60_000).toISOString(),
      oneOf: [
        { type: "Note", name: "Rojo", replies: { type: "Collection", totalItems: counts[0] } },
        { type: "Note", name: "Azul", replies: { type: "Collection", totalItems: counts[1] } },
        { type: "Note", name: "Verde", replies: { type: "Collection", totalItems: counts[2] } },
      ],
      votersCount: counts.reduce((a, b) => a + b, 0),
    };
  }

  function makeUpdateActivity(content: string, counts: number[]) {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/activities/update-q1",
      type: "Update",
      actor: ACTOR_ID,
      object: questionDocument(content, counts),
    };
  }

  it("refreshes the counts without marking the status as edited or recording history", async () => {
    await processInboxActivity(makeQuestionActivity() as never, { db, baseUrl: BASE } as never);
    const before = await getObjectById(db, QUESTION_ID);

    await processInboxActivity(
      makeUpdateActivity("<p>¿Cuál es tu color favorito?</p>", [3, 1, 0]) as never,
      { db, baseUrl: BASE } as never
    );

    const after = await getObjectById(db, QUESTION_ID);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    const edits = await db
      .prepare("SELECT COUNT(*) AS n FROM object_edits WHERE object_id = ?")
      .bind(QUESTION_ID)
      .all<{ n: number }>();
    expect(edits.results[0]?.n).toBe(0);

    const poll = await getPollByObjectId(db, QUESTION_ID);
    expect(poll?.votesCount).toBe(4);
    const options = poll ? await getPollOptions(db, poll.id) : [];
    expect(options.map((o) => o.votesCount)).toEqual([3, 1, 0]);
  });

  it("still records a real content edit as edited with history", async () => {
    await processInboxActivity(makeQuestionActivity() as never, { db, baseUrl: BASE } as never);
    const before = await getObjectById(db, QUESTION_ID);

    await processInboxActivity(
      makeUpdateActivity("<p>¿Cuál es tu color favorito? (editada)</p>", [0, 0, 0]) as never,
      { db, baseUrl: BASE } as never
    );

    const after = await getObjectById(db, QUESTION_ID);
    expect(after?.content).toContain("editada");
    expect(after?.updatedAt).not.toBe(before?.updatedAt);
    const edits = await db
      .prepare("SELECT COUNT(*) AS n FROM object_edits WHERE object_id = ?")
      .bind(QUESTION_ID)
      .all<{ n: number }>();
    expect(edits.results[0]?.n).toBe(1);
  });

  it("backfills the poll rows of an announce whose Question was cached without them", async () => {
    // As an older path left it: the object exists with content but no poll.
    await db
      .prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, published, updated_at)
         VALUES (?, 'Question', ?, '<p>¿Cuál es tu color favorito?</p>', 'public', 0, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .bind(QUESTION_ID, ACTOR_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO actors (id, username, domain, public_key_pem, is_local)
         VALUES ('https://remote.example/users/booster', 'booster', 'remote.example', 'k', 0)`
      )
      .run();

    await processInboxActivity(
      {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://remote.example/activities/announce-q1",
        type: "Announce",
        actor: "https://remote.example/users/booster",
        object: questionDocument("<p>¿Cuál es tu color favorito?</p>", [2, 1, 0]),
      } as never,
      { db, baseUrl: BASE } as never
    );

    const poll = await getPollByObjectId(db, QUESTION_ID);
    expect(poll).not.toBeNull();
    const options = poll ? await getPollOptions(db, poll.id) : [];
    expect(options.map((o) => o.title)).toEqual(["Rojo", "Azul", "Verde"]);
    // The embedded document carries the counts: they must show up right away.
    expect(poll?.votesCount).toBe(3);
    expect(options.map((o) => o.votesCount)).toEqual([2, 1, 0]);
  });
});
