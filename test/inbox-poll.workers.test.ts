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
