import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const mocks = vi.hoisted(() => ({
  enqueueDeliveries: vi.fn().mockResolvedValue(undefined),
  collectFollowerInboxes: vi.fn().mockResolvedValue(["https://remote.example/users/fan/inbox"]),
  resolveWebFinger: vi.fn(),
}));

vi.mock("@/lib/activitypub/queue", () => ({ enqueueDeliveries: mocks.enqueueDeliveries }));
vi.mock("@/lib/activitypub/federation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activitypub/federation")>()),
  collectFollowerInboxes: mocks.collectFollowerInboxes,
  resolveWebFinger: mocks.resolveWebFinger,
}));

import { NextRequest } from "next/server";
import { GET, POST, DELETE } from "@/app/api/v1/accounts/aliases/route";
import { GET as ACTOR_GET } from "@/app/api/users/[username]/route";

const db = env.DB;
const BASE = "https://local.example.test";
const TOKEN = "alias-token";
const ME = `${BASE}/users/me`;
const ALICE = `${BASE}/users/alice`;

async function seedLocal(username: string, opts: { emailVerified?: boolean } = {}): Promise<string> {
  const id = `${BASE}/users/${username}`;
  await db
    .prepare(
      `INSERT INTO actors (id, username, domain, public_key_pem, private_key_pem, is_local, email, email_verified)
       VALUES (?, ?, 'local.example.test', 'pub', 'priv', 1, ?, ?)`
    )
    .bind(id, username, `${username}@example.com`, opts.emailVerified === false ? 0 : 1)
    .run();
  return id;
}

async function seedToken(actorId: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO oauth_tokens (id, actor_id, app_id, access_token, scope, created_at) VALUES ('t1', ?, NULL, ?, 'read write', datetime('now'))"
    )
    .bind(actorId, TOKEN)
    .run();
}

function request(method: string, body?: unknown, query = ""): NextRequest {
  return new NextRequest(`${BASE}/api/v1/accounts/aliases${query}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  mocks.enqueueDeliveries.mockClear();
  mocks.collectFollowerInboxes.mockClear();
  mocks.resolveWebFinger.mockReset();
  mocks.resolveWebFinger.mockResolvedValue(null);
});

describe("migration aliases (alsoKnownAs)", () => {
  it("lists, adds and removes a local alias", async () => {
    await seedLocal("me");
    await seedToken(ME);
    await seedLocal("alice");

    const empty = await GET(request("GET"));
    expect((await empty.json()) as unknown).toEqual({ aliases: [] });

    const added = await POST(request("POST", { acct: "alice@local.example.test" }));
    expect(added.status).toBe(200);
    const addedBody = (await added.json()) as { uri: string; acct: string; aliases: { uri: string; acct: string }[] };
    expect(addedBody.uri).toBe(ALICE);
    expect(addedBody.acct).toBe("@alice@local.example.test");
    expect(addedBody.aliases).toHaveLength(1);

    // Stored on the actor and served in the AP document the source instance reads.
    const stored = await db.prepare("SELECT also_known_as FROM actors WHERE id = ?").bind(ME).first<{ also_known_as: string }>();
    expect(JSON.parse(stored!.also_known_as)).toEqual([ALICE]);

    const actorRes = await ACTOR_GET(new NextRequest(`${BASE}/users/me`), { params: Promise.resolve({ username: "me" }) });
    const actor = (await actorRes.json()) as { alsoKnownAs?: string[] };
    expect(actor.alsoKnownAs).toEqual([ALICE]);

    // The updated actor is pushed to the followers so the old instance can
    // verify the alias right away.
    expect(mocks.enqueueDeliveries).toHaveBeenCalledTimes(1);
    const queued = mocks.enqueueDeliveries.mock.calls[0][2] as string;
    expect(queued).toContain('"type":"Update"');
    expect(queued).toContain("alsoKnownAs");
    expect(queued).toContain(ALICE);

    const removed = await DELETE(request("DELETE", undefined, `?uri=${encodeURIComponent(ALICE)}`));
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { aliases: unknown[] }).aliases).toEqual([]);
    const after = await db.prepare("SELECT also_known_as FROM actors WHERE id = ?").bind(ME).first<{ also_known_as: string }>();
    expect(JSON.parse(after!.also_known_as)).toEqual([]);
  });

  it("resolves a remote alias through WebFinger and the cached actor", async () => {
    await seedLocal("me");
    await seedToken(ME);
    await db
      .prepare("INSERT INTO actors (id, username, domain, public_key_pem, is_local) VALUES (?,?,?,?,0)")
      .bind("https://remote.example/users/bob", "bob", "remote.example", "pub")
      .run();
    mocks.resolveWebFinger.mockResolvedValue("https://remote.example/users/bob");

    const res = await POST(request("POST", { acct: "@bob@remote.example" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { uri: string; acct: string };
    expect(body.uri).toBe("https://remote.example/users/bob");
    expect(body.acct).toBe("@bob@remote.example");
  });

  it("rejects an unknown account, your own account, a duplicate and a bad handle", async () => {
    await seedLocal("me");
    await seedToken(ME);
    await seedLocal("alice");

    const missing = await POST(request("POST", { acct: "nobody@local.example.test" }));
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as { error_code: string }).error_code).toBe("alias_error_not_found");

    const self = await POST(request("POST", { acct: "me@local.example.test" }));
    expect(self.status).toBe(422);
    expect(((await self.json()) as { error_code: string }).error_code).toBe("alias_error_self");

    const invalid = await POST(request("POST", { acct: "alice" }));
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error_code: string }).error_code).toBe("alias_error_invalid");

    expect((await POST(request("POST", { acct: "alice@local.example.test" }))).status).toBe(200);
    const duplicate = await POST(request("POST", { acct: "alice@local.example.test" }));
    expect(duplicate.status).toBe(422);
    expect(((await duplicate.json()) as { error_code: string }).error_code).toBe("alias_error_exists");
  });

  it("refuses to remove an alias that is not there", async () => {
    await seedLocal("me");
    await seedToken(ME);

    const res = await DELETE(request("DELETE", undefined, `?uri=${encodeURIComponent(ALICE)}`));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error_code: string }).error_code).toBe("alias_error_not_found");
  });

  it("requires authentication", async () => {
    const res = await GET(new NextRequest(`${BASE}/api/v1/accounts/aliases`));
    expect(res.status).toBe(401);
  });
});
