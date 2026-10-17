import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/activitypub/federation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/federation")>()),
  safeFetch: fetchMock,
}));

import { discoverProfileFeeds } from "@/lib/feed-discovery";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { GET as LOOKUP } from "@/app/api/v1/accounts/lookup/route";

const db = env.DB;
const BASE = env.INSTANCE_URL ?? "https://local.example.test";
const DOMAIN = new URL(BASE).hostname;

function feed(): Response {
  return new Response("<rss/>", { status: 200, headers: { "Content-Type": "application/rss+xml" } });
}

function missing(): Response {
  return new Response("nope", { status: 404, headers: { "Content-Type": "text/html" } });
}

async function seedActor(
  id: string,
  opts: { local?: boolean; suspended?: boolean } = {}
): Promise<string> {
  const username = id.split("/").pop()!;
  const domain = new URL(id).hostname;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, discoverable, suspended, email, email_verified)
       VALUES (?, ?, ?, 'pub', ?, ?, 1, ?, ?, 1)`
    )
    .bind(id, username, domain, opts.local === false ? null : "priv", opts.local === false ? 0 : 1, opts.suspended ? 1 : 0, `${username}@example.com`)
    .run();
  return id;
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  fetchMock.mockReset();
});

describe("discoverProfileFeeds", () => {
  it("points a local account at this instance's feeds", async () => {
    await seedActor(`${BASE}/users/alice`);

    const feeds = await discoverProfileFeeds(env, { username: "alice", domain: DOMAIN, isLocal: true, suspended: false }, DOMAIN);

    expect(feeds).toEqual({
      rss: `${BASE}/users/alice/rss`,
      atom: `${BASE}/users/alice/atom`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives a suspended account none (its content is not served)", async () => {
    await seedActor(`${BASE}/users/alice`, { suspended: true });

    expect(await discoverProfileFeeds(env, { username: "alice", domain: DOMAIN, isLocal: true, suspended: true }, DOMAIN)).toBeNull();
    expect(await discoverProfileFeeds(env, { username: "bob", domain: "remote.example", isLocal: false, suspended: true }, DOMAIN)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes a remote server once and caches what it serves", async () => {
    fetchMock.mockImplementation(async (url: string) => (url.endsWith(".rss") ? feed() : missing()));

    const actor = { username: "bob", domain: "remote.example", isLocal: false, suspended: false };
    expect(await discoverProfileFeeds(env, actor, DOMAIN)).toEqual({
      rss: "https://remote.example/@bob.rss",
      atom: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual([
      "https://remote.example/@bob.atom",
      "https://remote.example/@bob.rss",
    ]);

    // The second profile view answers from KV: no more probes.
    fetchMock.mockClear();
    expect(await discoverProfileFeeds(env, actor, DOMAIN)).toEqual({
      rss: "https://remote.example/@bob.rss",
      atom: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("remembers a server without feeds instead of probing every time", async () => {
    fetchMock.mockResolvedValue(missing());

    const actor = { username: "bob", domain: "remote.example", isLocal: false, suspended: false };
    expect(await discoverProfileFeeds(env, actor, DOMAIN)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    expect(await discoverProfileFeeds(env, actor, DOMAIN)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an unreachable origin as no feeds", async () => {
    fetchMock.mockResolvedValue(null);

    expect(await discoverProfileFeeds(env, { username: "bob", domain: "remote.example", isLocal: false, suspended: false }, DOMAIN)).toBeNull();
  });

  it("ignores a response that is not a feed", async () => {
    fetchMock.mockResolvedValue(new Response("<html/>", { status: 200, headers: { "Content-Type": "text/html" } }));

    expect(await discoverProfileFeeds(env, { username: "bob", domain: "remote.example", isLocal: false, suspended: false }, DOMAIN)).toBeNull();
  });
});

describe("the account entity", () => {
  it("links a remote account to its profile on its own server", async () => {
    const actor = {
      id: "https://remote.example/users/bob",
      username: "bob",
      domain: "remote.example",
      displayName: "Bob",
      isLocal: false,
      manuallyApprovesFollowers: false,
      isBot: false,
      discoverable: true,
      createdAt: "2026-01-01T00:00:00Z",
      followersCount: 0,
      followingCount: 0,
      statusesCount: 0,
    };
    // `url` is the human profile (Mastodon's semantics), `uri` the AP id: the
    // remote badge and "view original" open the profile, not the actor JSON.
    const account = serializeAccount(actor as never, DOMAIN);
    expect(account.url).toBe("https://remote.example/@bob");
    expect(account.uri).toBe("https://remote.example/users/bob");
  });
});

describe("the profile endpoints advertise the feeds", () => {
  it("returns them on lookup", async () => {
    await seedActor(`${BASE}/users/alice`);

    const res = await LOOKUP(new NextRequest(`${BASE}/api/v1/accounts/lookup?acct=alice`));
    expect(res.status).toBe(200);
    const account = (await res.json()) as { feeds?: { rss: string | null; atom: string | null } | null };
    expect(account.feeds).toEqual({
      rss: `${BASE}/users/alice/rss`,
      atom: `${BASE}/users/alice/atom`,
    });
  });
});
