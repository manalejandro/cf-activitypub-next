// @vitest-environment node
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

import { loadSerializedPolls } from "@/lib/mastodon/serializers";
import { createPoll, createPollVotes, getPollById, getPollOptions, listRemotePollsForRefresh } from "@/lib/db";
import { refreshPollFromQuestion } from "@/lib/activitypub/polls";

class D1Adapter {
  private sql = new DatabaseSync(":memory:");
  constructor(schemaSql: string) {
    this.sql.exec("PRAGMA foreign_keys = ON");
    this.sql.exec(schemaSql);
  }
  async batch(statements: { run(): Promise<D1Result> }[]): Promise<D1Result[]> {
    const results: D1Result[] = [];
    for (const s of statements) results.push(await s.run());
    return results;
  }
  prepare(query: string) {
    const stmt = this.sql.prepare(query);
    return {
      bind(...params: unknown[]) {
        const bound = params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
        return {
          async all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> {
            return { results: stmt.all(...(bound as never[])) as unknown as T[], success: true, meta: {} };
          },
          async first<T = unknown>(): Promise<T | null> {
            return (stmt.get(...(bound as never[])) as unknown as T | undefined) ?? null;
          },
          async run(): Promise<D1Result> {
            const info = stmt.run(...(bound as never[]));
            return { success: true, meta: { changes: info.changes }, results: [] } as unknown as D1Result<unknown>;
          },
        };
      },
    };
  }
}

describe("loadSerializedPolls", () => {
  it("marks a poll as voted for the viewer who voted and leaves others untouched", async () => {
    const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
    const db = new D1Adapter(schema) as unknown as D1Database;
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://local.example/objects/1', 'Note', 'https://local.example/users/me', 'q', 'public', 1, '{}')`
    ).bind().run();
    await db.prepare(
      "INSERT INTO polls (id, object_id, expires_at, multiple, votes_count, voters_count) VALUES ('p1', 'https://local.example/objects/1', ?, 0, 1, 1)"
    ).bind(new Date(Date.now() + 60_000).toISOString()).run();
    await db.prepare("INSERT INTO poll_options (id, poll_id, title, votes_count, position) VALUES ('o1','p1','A',1,0)").bind().run();
    await db.prepare("INSERT INTO poll_options (id, poll_id, title, votes_count, position) VALUES ('o2','p1','B',0,1)").bind().run();
    await db.prepare(
      "INSERT INTO poll_votes (id, poll_id, actor_id, option_idx) VALUES ('v1','p1','https://local.example/users/me',0)"
    ).bind().run();

    const map = await loadSerializedPolls(db, "https://local.example/users/me", ["https://local.example/objects/1"]);
    const poll = map.get("https://local.example/objects/1");
    expect(poll?.voted).toBe(true);
    expect(poll?.own_votes).toEqual([0]);

    const anonymous = await loadSerializedPolls(db, null, ["https://local.example/objects/1"]);
    expect(anonymous.get("https://local.example/objects/1")?.voted).toBe(false);
    expect(anonymous.get("https://local.example/objects/1")?.own_votes).toEqual([]);
  });
});

describe("refreshPollFromQuestion", () => {
  async function seedRemotePoll(db: D1Database): Promise<void> {
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://remote.example/users/author', 'author', 'remote.example', 'k', NULL, 0)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://remote.example/objects/q1', 'Question', 'https://remote.example/users/author', 'poll', 'public', 0, '{}')`
    ).bind().run();
    await createPoll(db, {
      id: "p-remote",
      objectId: "https://remote.example/objects/q1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      multiple: false,
      options: [
        { id: "ro1", title: "A", position: 0 },
        { id: "ro2", title: "B", position: 1 },
      ],
    });
  }

  it("applies the origin's per-choice counts and totals without touching local votes", async () => {
    const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
    const db = new D1Adapter(schema) as unknown as D1Database;
    await seedRemotePoll(db);
    // A local vote already recorded (must survive the refresh).
    await db.prepare(
      "INSERT INTO poll_votes (id, poll_id, actor_id, option_idx) VALUES ('lv','p-remote','https://remote.example/users/author',0)"
    ).bind().run();

    const ok = await refreshPollFromQuestion(db, {
      id: "https://remote.example/objects/q1",
      type: "Question",
      oneOf: [
        { name: "A", replies: { totalItems: 7 } },
        { name: "B", replies: { totalItems: 3 } },
      ],
      votersCount: 9,
    });
    expect(ok).toBe(true);

    const options = await getPollOptions(db, "p-remote");
    expect(options.map((o) => o.votesCount)).toEqual([7, 3]);
    const poll = await getPollById(db, "p-remote");
    expect(poll?.votesCount).toBe(10);
    expect(poll?.votersCount).toBe(9);
    const localVotes = await db.prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = 'p-remote'").bind().first<{ n: number }>();
    expect(localVotes?.n).toBe(1);
  });

  it("ignores a partial document instead of clobbering the counts", async () => {
    const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
    const db = new D1Adapter(schema) as unknown as D1Database;
    await seedRemotePoll(db);

    const ok = await refreshPollFromQuestion(db, {
      id: "https://remote.example/objects/q1",
      type: "Question",
      oneOf: [{ name: "A", replies: { totalItems: 5 } }],
    });
    expect(ok).toBe(false);
    const options = await getPollOptions(db, "p-remote");
    expect(options.map((o) => o.votesCount)).toEqual([0, 0]);
  });
});

describe("createPollVotes", () => {
  it("counts one voter for a multiple-choice vote (votes_count per choice)", async () => {
    const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
    const db = new D1Adapter(schema) as unknown as D1Database;
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://local.example/users/me', 'me', 'local.example', 'k', 'p', 1)`
    ).bind().run();
    await db.prepare(
      `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw)
       VALUES ('https://local.example/objects/q2', 'Question', 'https://local.example/users/me', 'poll', 'public', 1, '{}')`
    ).bind().run();
    await createPoll(db, {
      id: "p-multi",
      objectId: "https://local.example/objects/q2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      multiple: true,
      options: [
        { id: "mo1", title: "A", position: 0 },
        { id: "mo2", title: "B", position: 1 },
      ],
    });

    await createPollVotes(db, "p-multi", "https://local.example/users/me", [0, 1]);
    const poll = await getPollById(db, "p-multi");
    expect(poll?.votesCount).toBe(2);
    expect(poll?.votersCount).toBe(1);
    const options = await getPollOptions(db, "p-multi");
    expect(options.map((o) => o.votesCount)).toEqual([1, 1]);
  });
});

describe("listRemotePollsForRefresh", () => {
  it("selects only active remote polls from recent statuses", async () => {
    const schema = readFileSync(join(process.cwd(), "lib/db/schema.sql"), "utf8");
    const db = new D1Adapter(schema) as unknown as D1Database;
    await db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local)
       VALUES ('https://remote.example/users/author', 'author', 'remote.example', 'k', NULL, 0)`
    ).bind().run();
    const insertObject = async (id: string, isLocal: number, published: string) => {
      await db.prepare(
        `INSERT INTO objects (id, type, actor_id, content, visibility, is_local, raw, published)
         VALUES (?, 'Question', 'https://remote.example/users/author', 'poll', 'public', ?, '{}', ?)`
      ).bind(id, isLocal, published).run();
    };
    const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
    await insertObject("https://remote.example/objects/fresh", 0, iso(0));
    await insertObject("https://remote.example/objects/old", 0, iso(-30 * 86400000));
    await insertObject("https://remote.example/objects/local", 1, iso(0));
    for (const [id, objectId, expires] of [
      ["p-fresh", "https://remote.example/objects/fresh", iso(3600_000)],
      ["p-old", "https://remote.example/objects/old", iso(3600_000)],
      ["p-local", "https://remote.example/objects/local", iso(3600_000)],
      ["p-expired", "https://remote.example/objects/fresh", iso(-1000)],
    ]) {
      await db.prepare(
        "INSERT INTO polls (id, object_id, expires_at, multiple, votes_count, voters_count) VALUES (?,?,?,0,0,0)"
      ).bind(id, objectId, expires).run();
    }

    const due = await listRemotePollsForRefresh(db, 10);
    expect(due.map((p) => p.id)).toEqual(["p-fresh"]);
  });
});
