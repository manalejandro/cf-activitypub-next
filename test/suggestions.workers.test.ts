import { beforeAll, describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyTestSchema, resetTestDatabase } from "./helpers/db";

beforeAll(async () => {
  await applyTestSchema();
});

import { getAccountSuggestions, dismissSuggestedAccount, undismissSuggestedAccount } from "@/lib/db";

type ActorOpts = {
  isLocal?: boolean;
  discoverable?: boolean;
  suspended?: boolean;
  silenced?: boolean;
  reserved?: boolean;
  statuses?: number;
  followers?: number;
  lastStatusAt?: string | null;
};

function insertActor(db: D1Database, id: string, opts: ActorOpts = {}) {
  const username = id.split("/").pop()!.split("@")[0];
  const domain = id.split("/")[2].split(":")[0];
  return db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, suspended, silenced, reserved, statuses_count, followers_count, last_status_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      id,
      username,
      domain,
      "k",
      opts.isLocal ? "p" : null,
      opts.isLocal ? 1 : 0,
      opts.discoverable === false ? 0 : 1,
      opts.suspended ? 1 : 0,
      opts.silenced ? 1 : 0,
      opts.reserved ? 1 : 0,
      opts.statuses ?? 1,
      opts.followers ?? 0,
      opts.lastStatusAt ?? null
    )
    .run();
}

function insertFollow(db: D1Database, actorId: string, targetId: string, state = "accepted") {
  return db
    .prepare("INSERT INTO follows (id, actor_id, target_id, state) VALUES (?,?,?,?)")
    .bind(`${actorId}->${targetId}`, actorId, targetId, state)
    .run();
}

const ME = "https://local.example/users/me";

const db = env.DB;

beforeEach(async () => {
  await resetTestDatabase();
  await insertActor(db, ME, { isLocal: true, lastStatusAt: "2025-01-01T00:00:00Z" });
});

describe("getAccountSuggestions", () => {
  it("anonymous viewers get the local community, including accounts without posts", async () => {
    await insertActor(db, "https://local.example/users/active-a", { isLocal: true, lastStatusAt: "2026-02-01T00:00:00Z", followers: 3 });
    await insertActor(db, "https://local.example/users/active-b", { isLocal: true, lastStatusAt: "2026-01-15T00:00:00Z", followers: 9 });
    await insertActor(db, "https://local.example/users/no-status", { isLocal: true, statuses: 0, lastStatusAt: null });
    await insertActor(db, "https://local.example/users/suspended", { isLocal: true, suspended: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/silenced", { isLocal: true, silenced: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/undiscoverable", { isLocal: true, discoverable: false, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://remote.example/users/remote", { isLocal: false, lastStatusAt: "2026-03-01T00:00:00Z" });

    const out = await getAccountSuggestions(db, null);
    const ids = out.map((s) => s.actor.id);
    expect(new Set(ids)).toEqual(new Set([
      ME,
      "https://local.example/users/active-a",
      "https://local.example/users/active-b",
      "https://local.example/users/no-status",
    ]));
    expect(out.every((s) => s.source === "global")).toBe(true);
    // A brand-new account that has not posted yet is still suggested.
    expect(ids).toContain("https://local.example/users/no-status");
    expect(ids).not.toContain("https://local.example/users/suspended");
    expect(ids).not.toContain("https://local.example/users/silenced");
    expect(ids).not.toContain("https://local.example/users/undiscoverable");
  });

  it("rotates the pools daily: same seed repeats, another seed reshuffles", async () => {
    for (let i = 0; i < 8; i++) {
      await insertActor(db, `https://local.example/users/member-${i}`, { isLocal: true, lastStatusAt: "2026-01-01T00:00:00Z" });
    }

    const day1 = (await getAccountSuggestions(db, null, { rotationSeed: 1 })).map((s) => s.actor.id);
    const day1again = (await getAccountSuggestions(db, null, { rotationSeed: 1 })).map((s) => s.actor.id);
    expect(day1again).toEqual(day1);

    const day2 = (await getAccountSuggestions(db, null, { rotationSeed: 2 })).map((s) => s.actor.id);
    expect(new Set(day2)).toEqual(new Set(day1));
    expect(day2).not.toEqual(day1);
  });

  it("rotates even when the scores differ (the tie-only rotation was invisible)", async () => {
    // Distinct local-follow counts: 6, 5, 4, 3, 2, 1. The followers are
    // remote so they don't compete for slots in the local pool.
    for (let i = 0; i < 6; i++) {
      const target = `https://local.example/users/ranked-${i}`;
      await insertActor(db, target, { isLocal: true, lastStatusAt: "2026-01-01T00:00:00Z" });
      for (let f = 0; f < 6 - i; f++) {
        const follower = `https://remote.example/users/fan-${i}-${f}`;
        await insertActor(db, follower, { isLocal: false });
        await insertFollow(db, follower, target);
      }
    }

    const day1 = (await getAccountSuggestions(db, null, { rotationSeed: 11 })).map((s) => s.actor.id);
    const day2 = (await getAccountSuggestions(db, null, { rotationSeed: 12 })).map((s) => s.actor.id);

    expect(new Set(day2)).toEqual(new Set(day1));
    expect(day2).not.toEqual(day1);
    // Relevance is kept between windows: the five most-followed accounts stay
    // in the first window, only their order rotates.
    const topWindow = new Set(day1.slice(0, 5));
    expect(day2.slice(0, 5).every((id) => topWindow.has(id))).toBe(true);
  });

  it("ranks friends-of-friends first and excludes followed, blocked, muted and dismissed accounts", async () => {
    await insertActor(db, "https://local.example/users/followed", { isLocal: true });
    await insertActor(db, "https://local.example/users/fof1", { isLocal: true, lastStatusAt: "2026-01-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/fof2", { isLocal: true, lastStatusAt: "2026-01-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/popular", { isLocal: true, lastStatusAt: "2026-02-01T00:00:00Z", followers: 100 });
    await insertActor(db, "https://local.example/users/blocked", { isLocal: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/muted", { isLocal: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/dismissed", { isLocal: true, lastStatusAt: "2026-03-01T00:00:00Z" });

    await insertFollow(db, ME, "https://local.example/users/followed");
    // followed -> fof1 and fof2; another follower also -> fof1, so fof1 scores
    // higher (the score decides which window it lands in, not its exact slot).
    await insertFollow(db, "https://local.example/users/followed", "https://local.example/users/fof1");
    await insertFollow(db, "https://local.example/users/followed", "https://local.example/users/fof2");
    await insertActor(db, "https://local.example/users/other", { isLocal: true });
    await insertFollow(db, ME, "https://local.example/users/other");
    await insertFollow(db, "https://local.example/users/other", "https://local.example/users/fof1");
    await db.prepare("INSERT INTO blocks (id, actor_id, target_id) VALUES (?,?,?)").bind("b1", ME, "https://local.example/users/blocked").run();
    await db.prepare("INSERT INTO mutes (id, actor_id, target_id) VALUES (?,?,?)").bind("m1", ME, "https://local.example/users/muted").run();
    await dismissSuggestedAccount(db, ME, "https://local.example/users/dismissed");

    // Pending follows of mine must not count either.
    await insertActor(db, "https://local.example/users/pending", { isLocal: true });
    await insertFollow(db, ME, "https://local.example/users/pending", "pending");

    const ids = (await getAccountSuggestions(db, ME)).map((s) => s.actor.id);
    expect(ids).not.toContain("https://local.example/users/followed");
    expect(ids).not.toContain("https://local.example/users/blocked");
    expect(ids).not.toContain("https://local.example/users/muted");
    expect(ids).not.toContain("https://local.example/users/dismissed");
    expect(ids).not.toContain("https://local.example/users/pending");

    const fof1 = ids.indexOf("https://local.example/users/fof1");
    const fof2 = ids.indexOf("https://local.example/users/fof2");
    const popular = ids.indexOf("https://local.example/users/popular");
    // The whole friends-of-friends pool leads the page (before the local pool
    // that holds `popular`). Their relative order is deliberately not asserted:
    // inside a window of SUGGESTION_ROTATE_WINDOW the order rotates with the
    // day seed, so the assertion used to pass or fail depending on the date.
    expect(fof1).toBeGreaterThanOrEqual(0);
    expect(fof2).toBeGreaterThanOrEqual(0);
    expect(fof1).toBeLessThan(popular);
    expect(fof2).toBeLessThan(popular);

    const byId = new Map((await getAccountSuggestions(db, ME)).map((s) => [s.actor.id, s.source]));
    expect(byId.get("https://local.example/users/fof1")).toBe("friends_of_friends");
    expect(byId.get("https://local.example/users/popular")).toBe("global");
  });

  it("suggests local and remote accounts that are popular on this instance", async () => {
    await insertActor(db, "https://remote.example/users/remote-pop", { isLocal: false, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/local-pop", { isLocal: true, lastStatusAt: "2026-02-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/someone", { isLocal: true });
    await insertFollow(db, "https://local.example/users/someone", "https://remote.example/users/remote-pop");
    await insertFollow(db, "https://local.example/users/someone", "https://local.example/users/local-pop");

    const out = await getAccountSuggestions(db, null);
    const remote = out.find((s) => s.actor.id === "https://remote.example/users/remote-pop");
    expect(remote?.source).toBe("global");
    expect(remote?.actor.isLocal).toBe(false);
    expect(out.find((s) => s.actor.id === "https://local.example/users/local-pop")?.source).toBe("global");
    // The local community leads the page; popular remote accounts follow.
    expect(out.findIndex((s) => s.actor.id === ME)).toBeLessThan(
      out.findIndex((s) => s.actor.id === "https://remote.example/users/remote-pop")
    );
  });

  it("still excludes popular accounts the viewer already follows or dismissed", async () => {
    await insertActor(db, "https://remote.example/users/remote-pop", { isLocal: false, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/someone", { isLocal: true });
    await insertFollow(db, "https://local.example/users/someone", "https://remote.example/users/remote-pop");
    await insertFollow(db, ME, "https://remote.example/users/remote-pop");

    const followed = await getAccountSuggestions(db, ME);
    expect(followed.map((s) => s.actor.id)).not.toContain("https://remote.example/users/remote-pop");

    await undismissSuggestedAccount(db, ME, "https://remote.example/users/remote-pop");
    await dismissSuggestedAccount(db, ME, "https://remote.example/users/remote-pop");
    const dismissed = await getAccountSuggestions(db, ME);
    expect(dismissed.map((s) => s.actor.id)).not.toContain("https://remote.example/users/remote-pop");
  });

  it("suggests popular accounts from instances nobody here follows yet", async () => {
    await insertActor(db, "https://new.example/users/popular", { isLocal: false, lastStatusAt: "2026-03-01T00:00:00Z", followers: 500 });
    await insertActor(db, "https://new.example/users/quiet", { isLocal: false, lastStatusAt: "2026-03-01T00:00:00Z", followers: 0 });
    await insertActor(db, "https://known.example/users/popular", { isLocal: false, lastStatusAt: "2026-03-01T00:00:00Z", followers: 900 });
    await insertActor(db, "https://local.example/users/someone", { isLocal: true });
    // One local follow on `known.example` is enough to take the whole instance
    // out of the new-instances pool (that is the point: widen the federation).
    await insertFollow(db, "https://local.example/users/someone", "https://known.example/users/popular");

    const out = await getAccountSuggestions(db, null);
    const byId = new Map(out.map((s) => [s.actor.id, s.source]));
    expect(byId.get("https://new.example/users/popular")).toBe("new_instances");
    expect(byId.get("https://known.example/users/popular")).toBe("global");
    // Advertised follower count is the popularity signal for unknown servers.
    expect(out.map((s) => s.actor.id)).not.toContain("https://new.example/users/quiet");
  });

  it("keeps accounts of suspended instances out of every pool", async () => {
    await insertActor(db, "https://blocked.example/users/popular", { isLocal: false, lastStatusAt: "2026-03-01T00:00:00Z", followers: 900 });
    await insertActor(db, "https://local.example/users/someone", { isLocal: true });
    await insertFollow(db, "https://local.example/users/someone", "https://blocked.example/users/popular");
    await db
      .prepare("INSERT INTO instance_domain_blocks (domain, severity) VALUES (?, 'suspend')")
      .bind("blocked.example")
      .run();

    const out = await getAccountSuggestions(db, null);
    expect(out.map((s) => s.actor.id)).not.toContain("https://blocked.example/users/popular");
  });

  it("supports limit/offset and keeps dismissals idempotent", async () => {
    await insertActor(db, "https://local.example/users/a", { isLocal: true, lastStatusAt: "2026-03-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/b", { isLocal: true, lastStatusAt: "2026-02-01T00:00:00Z" });
    await insertActor(db, "https://local.example/users/c", { isLocal: true, lastStatusAt: "2026-01-01T00:00:00Z" });

    const first = await getAccountSuggestions(db, null, { limit: 2, rotationSeed: 7 });
    const second = await getAccountSuggestions(db, null, { limit: 2, offset: 2, rotationSeed: 7 });
    expect(first).toHaveLength(2);
    // Paging keeps the same order and never repeats an account.
    expect(new Set([...first, ...second].map((s) => s.actor.id)).size).toBe(4);
    expect((await getAccountSuggestions(db, null, { limit: 2, rotationSeed: 7 })).map((s) => s.actor.id))
      .toEqual(first.map((s) => s.actor.id));

    await dismissSuggestedAccount(db, ME, "https://local.example/users/a");
    await dismissSuggestedAccount(db, ME, "https://local.example/users/a");
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM dismissed_suggestions WHERE actor_id = ?")
      .bind(ME)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const after = await getAccountSuggestions(db, ME);
    expect(after.map((s) => s.actor.id)).not.toContain("https://local.example/users/a");

    await undismissSuggestedAccount(db, ME, "https://local.example/users/a");
    const restored = await getAccountSuggestions(db, ME);
    expect(restored.map((s) => s.actor.id)).toContain("https://local.example/users/a");
  });
});
