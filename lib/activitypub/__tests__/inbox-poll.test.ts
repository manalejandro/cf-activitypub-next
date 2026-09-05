// @vitest-environment node
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { processInboxActivity } from "@/lib/activitypub/inbox";
import { getPollByObjectId, getPollOptions, getObjectById, getPollsByObjectIds } from "@/lib/db";
import { broadcastPublicStatus } from "@/lib/streaming/broadcast";

vi.mock("@/lib/streaming/broadcast", () => ({
  broadcastNotificationEvent: vi.fn().mockResolvedValue(undefined),
  broadcastPublicStatus: vi.fn().mockResolvedValue(undefined),
  broadcastHomeStatus: vi.fn().mockResolvedValue(undefined),
  broadcastCallEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/push", () => ({
  deliverPushSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/activitypub/federation", () => ({
  deliverToInbox: vi.fn().mockResolvedValue(undefined),
  fetchRemoteObject: vi.fn().mockResolvedValue(null),
}));

/** Minimal D1 adapter backed by node:sqlite (in-memory, schema loaded). */
class D1Adapter {
  private sql = new DatabaseSync(":memory:");
  private allCounter = 0;

  constructor(schemaSql: string) {
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(schemaSql);
  }

  async batch(statements: { run(): Promise<D1Result> }[]): Promise<D1Result[]> {
    this.sql.exec("BEGIN");
    try {
      const results: D1Result[] = [];
      for (const s of statements) results.push(await s.run());
      this.sql.exec("COMMIT");
      return results;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }

  prepare(query: string) {
    const stmt = this.sql.prepare(query);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const adapter = this;
    return {
      bind(...params: unknown[]) {
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
        return {
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
            const rows = stmt.all(...(bound as never[])) as unknown as T[];
            adapter.allCounter++;
            return { results: rows, success: true, meta: {} };
          },
          async first<T = unknown>(): Promise<T | null> {
            const row = stmt.get(...(bound as never[])) as unknown as T | undefined;
            adapter.allCounter++;
            return row ?? null;
          },
          async run(): Promise<D1Result> {
            const info = stmt.run(...(bound as never[]));
            adapter.allCounter++;
            return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
          },
        };
      },
      async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
        const rows = stmt.all() as unknown as T[];
        adapter.allCounter++;
        return { results: rows, success: true, meta: {} };
      },
      async first<T = unknown>(): Promise<T | null> {
        const row = stmt.get() as unknown as T | undefined;
        adapter.allCounter++;
        return row ?? null;
      },
      async run(): Promise<D1Result> {
        const info = stmt.run();
        adapter.allCounter++;
        return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
      },
    };
  }
}

let db: D1Database;
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
  const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
  const adapter = new D1Adapter(schema);
  const d = adapter as unknown as D1Database;
  await d
    .prepare(
      "INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(ACTOR_ID, "alice", "remote.example", "test-key", 0)
    .run();
  return d;
}

describe("federated poll ingestion (Create Question)", () => {
  beforeEach(async () => {
    db = await freshDb();
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
