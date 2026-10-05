import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { detectSpamDomains } from "@/lib/moderation/cycle";

const db = env.DB;

beforeEach(async () => {
  await resetTestDatabase();
});

function insertActor(id: string, username: string, domain: string, suspended = 0) {
  return db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, is_local, suspended)
     VALUES (?, ?, ?, 'pem', 0, ?)`
    )
    .bind(id, username, domain, suspended ? 1 : 0);
}

/** D1 batches in chunks: 12k single round-trips blow the 5 s test timeout. */
async function insertActors(statements: ReturnType<typeof insertActor>[]): Promise<void> {
  for (let i = 0; i < statements.length; i += 500) {
    await db.batch(statements.slice(i, i + 500));
  }
}

/**
 * Regression test for the 2026-08-16 incident: the old `HAVING c >= 3` absolute
 * threshold made the Guardian block whole large instances (mastodon.social was
 * suspended — 11,547 collateral accounts — for just 3 real spammers). The fixed
 * rule requires BOTH an absolute count (>= 3) AND that the spammers make up
 * >= 50% of the domain's cached accounts.
 */
describe("detectSpamDomains proportional threshold", () => {
  it("does NOT block a large legitimate domain with a handful of spammers", async () => {
    // 12,000 cached mastodon.social accounts, only 3 suspended.
    await insertActors(
      Array.from({ length: 12000 }, (_, i) =>
        insertActor(`https://mastodon.social/users/u${i}`, `u${i}`, "mastodon.social", i < 3 ? 1 : 0)
      )
    );

    await detectSpamDomains({ DB: db, INSTANCE_URL: "https://cf-ap.example" } as never);

    const blocks = (await db.prepare("SELECT domain FROM domain_blocks").all<{ domain: string }>()).results;
    expect(blocks).toEqual([]);
  });

  it("blocks a small domain where the majority of cached accounts are spammers", async () => {
    await insertActors([
      insertActor("https://spam.example/users/a", "a", "spam.example", 1),
      insertActor("https://spam.example/users/b", "b", "spam.example", 1),
      insertActor("https://spam.example/users/c", "c", "spam.example", 1),
      insertActor("https://spam.example/users/d", "d", "spam.example", 0),
    ]);

    await detectSpamDomains({ DB: db, INSTANCE_URL: "https://cf-ap.example" } as never);

    const blocks = (await db.prepare("SELECT domain FROM domain_blocks").all<{ domain: string }>()).results;
    expect(blocks.map((b) => b.domain)).toContain("spam.example");
  });

  it("does NOT block a domain with 3 spammers out of a larger pool (below 50%)", async () => {
    await insertActors(
      Array.from({ length: 10 }, (_, i) => insertActor(`https://mixed.example/users/u${i}`, `u${i}`, "mixed.example", i < 3 ? 1 : 0))
    );
    await detectSpamDomains({ DB: db, INSTANCE_URL: "https://cf-ap.example" } as never);
    const blocks = (await db.prepare("SELECT domain FROM domain_blocks").all<{ domain: string }>()).results;
    expect(blocks).toEqual([]);
  });

  it("never blocks the instance's own domain", async () => {
    await insertActors([
      insertActor("https://cf-ap.example/users/a", "a", "cf-ap.example", 1),
      insertActor("https://cf-ap.example/users/b", "b", "cf-ap.example", 1),
      insertActor("https://cf-ap.example/users/c", "c", "cf-ap.example", 1),
    ]);

    await detectSpamDomains({ DB: db, INSTANCE_URL: "https://cf-ap.example" } as never);

    const blocks = (await db.prepare("SELECT domain FROM domain_blocks").all<{ domain: string }>()).results;
    expect(blocks).toEqual([]);
  });

  it("does not re-block an already blocked domain", async () => {
    db.prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, is_local)
       VALUES ('https://cf-ap.example/users/guardian', 'guardian', 'cf-ap.example', 'pem', 1)`
    ).run();
    db.prepare("INSERT INTO domain_blocks (id, actor_id, domain) VALUES ('b1', 'https://cf-ap.example/users/guardian', 'already.example')").run();
    insertActor("https://already.example/users/a", "a", "already.example", 1);
    insertActor("https://already.example/users/b", "b", "already.example", 1);
    insertActor("https://already.example/users/c", "c", "already.example", 1);

    await detectSpamDomains({ DB: db, INSTANCE_URL: "https://cf-ap.example" } as never);

    const count = await db.prepare("SELECT COUNT(*) AS c FROM domain_blocks WHERE domain = 'already.example'").first<{ c: number }>();
    expect(count?.c ?? 0).toBe(1);
  });
});