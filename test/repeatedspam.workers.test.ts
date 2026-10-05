import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});
import { detectRepeatedSpam } from "@/lib/moderation/cycle";

const db = env.DB;

const PEM = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----";

async function insertActor(id: string, domain: string, opts: { suspended?: boolean } = {}) {
  const username = id.split("/").pop() ?? "u";
  await db.prepare(
    `INSERT INTO actors (id, username, domain, display_name, public_key_pem, private_key_pem, is_local,
       followers_count, following_count, statuses_count, suspended, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, 0, ?, datetime('now', '-30 days'))`
  ).bind(id, username.toLowerCase(), domain, username, PEM, opts.suspended ? 1 : 0).run();
}

async function insertStatus(actorId: string, content: string, hoursAgo: number) {
  const id = `${actorId}/posts/${Math.random().toString(36).slice(2)}`;
  // Production stores ISO timestamps (toISOString), so the test must too — the
  // space-vs-T difference between `datetime('now')` and ISO makes string
  // comparisons time-of-day dependent around midnight.
  const published = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  await db.prepare(
    `INSERT INTO objects (id, type, actor_id, content, content_warning, sensitive, visibility, is_local, published)
     VALUES (?, 'Note', ?, ?, NULL, 0, 'public', 0, ?)`
  ).bind(id, actorId, content, published).run();
}

async function actionsFor(actorId: string): Promise<Array<{ action: string }>> {
  return (await db
    .prepare("SELECT action FROM moderation_log WHERE target_type = 'account' AND target_id = ? ORDER BY rowid")
    .bind(actorId)
    .all<{ action: string }>()).results;
}

beforeEach(async () => {
  await resetTestDatabase();
});

/**
 * Regression test for the 2026-08-17 incident: `detectRepeatedSpam` suspended
 * harmless high-volume users from mastodon.social for repeating messages that
 * are NOT spam (greetings, hashtags, meme captions). Real log entries hit
 * accounts posting e.g. `@Solpizzarro ✌️👊` x7, `#StarTrek` x3, `✨ c a t ✨` x3
 * and hashtag-heavy photography captions x4.
 */
describe("detectRepeatedSpam", () => {
  it("does NOT act on repeated benign content (greetings, hashtags, memes)", async () => {
    const actorId = "https://mastodon.social/users/solpizzarro";
    await insertActor(actorId, "mastodon.social");
    for (let i = 0; i < 10; i++) {
      await insertStatus(actorId, `<p>@Solpizzarro ✌️👊</p>`, i);
    }

    await detectRepeatedSpam({ DB: db, INSTANCE_URL: "https://cf-ap.example", KV: undefined } as never);

    expect(await actionsFor(actorId)).toEqual([]);
    const actor = await db.prepare("SELECT suspended FROM actors WHERE id = ?").bind(actorId).first<{ suspended: number }>();
    expect(actor?.suspended).toBe(0);
  });

  it("does NOT act on repeated hashtag-heavy captions", async () => {
    const actorId = "https://mastodon.social/users/photog";
    await insertActor(actorId, "mastodon.social");
    const caption = "<p>#colorphotography #colorshots #portrait #landscape #streetphoto</p>";
    for (let i = 0; i < 6; i++) await insertStatus(actorId, caption, i);

    await detectRepeatedSpam({ DB: db, INSTANCE_URL: "https://cf-ap.example", KV: undefined } as never);

    expect(await actionsFor(actorId)).toEqual([]);
  });

  it("warns (not suspends) a first-time account repeating spam-like content 5+ times", async () => {
    const actorId = "https://spam.example/users/bot";
    await insertActor(actorId, "spam.example");
    const spam = "<p>gana dinero rápido clic aquí https://scam.example/win</p>";
    for (let i = 0; i < 5; i++) await insertStatus(actorId, spam, i);

    await detectRepeatedSpam({ DB: db, INSTANCE_URL: "https://cf-ap.example", KV: undefined } as never);

    const actions = await actionsFor(actorId);
    expect(actions.filter((a) => a.action === "warned").length).toBe(1);
    expect(actions.some((a) => a.action === "suspended")).toBe(false);
  });

  it("suspend a repeat offender that already had a warning", async () => {
    const actorId = "https://spam.example/users/offender";
    await insertActor(actorId, "spam.example");
    db.prepare(
      `INSERT INTO moderation_log (id, source, target_type, target_id, action, reason, confidence, model, details)
       VALUES ('w1', 'heuristic', 'account', ?, 'warned', 'previo', 'medium', 'heuristic', '{}')`
    ).bind(actorId).run();

    const spam = "<p>compra barato ahora hazte millonario https://scam.example/deal</p>";
    for (let i = 0; i < 5; i++) await insertStatus(actorId, spam, i);

    await detectRepeatedSpam({ DB: db, INSTANCE_URL: "https://cf-ap.example", KV: undefined } as never);

    expect((await actionsFor(actorId)).some((a) => a.action === "suspended")).toBe(true);
  });

  it("does nothing below the 5-repeat threshold", async () => {
    const actorId = "https://spam.example/users/small";
    await insertActor(actorId, "spam.example");
    const spam = "<p>gana dinero https://scam.example/x</p>";
    for (let i = 0; i < 4; i++) await insertStatus(actorId, spam, i);

    await detectRepeatedSpam({ DB: db, INSTANCE_URL: "https://cf-ap.example", KV: undefined } as never);

    expect(await actionsFor(actorId)).toEqual([]);
  });
});