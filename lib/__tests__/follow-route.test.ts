// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  getAuthenticatedActor: vi.fn(),
  getActorById: vi.fn(),
  getFollow: vi.fn(),
  createFollow: vi.fn(async () => {}),
  fetchAndCacheRemoteActor: vi.fn(async () => null),
  enqueueDeliveries: vi.fn(async () => {}),
  notify: vi.fn(async () => {}),
  buildRelationship: vi.fn(async () => ({ id: "rel", following: true, requested: false })),
  statements: [] as { sql: string; args: unknown[] }[],
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  notFound: (msg = "Not found") => new Response(JSON.stringify({ error: msg }), { status: 404 }),
  unauthorized: () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
}));
vi.mock("@/lib/auth", () => ({ getAuthenticatedActor: mocks.getAuthenticatedActor }));
vi.mock("@/lib/db", () => ({
  getActorById: mocks.getActorById,
  getFollow: mocks.getFollow,
  createFollow: mocks.createFollow,
}));
vi.mock("@/lib/activitypub/queue", () => ({ enqueueDeliveries: mocks.enqueueDeliveries }));
vi.mock("@/lib/activitypub/remote", () => ({ fetchAndCacheRemoteActor: mocks.fetchAndCacheRemoteActor }));
vi.mock("@/lib/notify", () => ({ notify: mocks.notify }));
vi.mock("@/lib/mastodon/relationships", () => ({ buildRelationship: mocks.buildRelationship }));

import { POST } from "@/app/api/v1/accounts/[id]/follow/route";

const LOCAL = "https://cf-ap.com/users/me";
const REMOTE = "https://remote.example/users/alice";

function makeDb() {
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          mocks.statements.push({ sql, args });
          return { success: true, meta: { changes: 1 }, results: [] };
        },
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} }),
      }),
    }),
  };
}

function request(): Request {
  return new Request(`https://cf-ap.com/api/v1/accounts/${encodeURIComponent(REMOTE)}/follow`, { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.statements.length = 0;
  mocks.getCloudflareContext.mockReturnValue({ env: { DB: makeDb(), KV: {} } });
  mocks.getAuthenticatedActor.mockResolvedValue({ id: LOCAL, username: "me", privateKeyPem: "priv" });
  mocks.getActorById.mockResolvedValue({
    id: REMOTE,
    username: "alice",
    domain: "remote.example",
    isLocal: false,
    inbox: "https://remote.example/inbox",
    manuallyApprovesFollowers: false,
  });
  mocks.getFollow.mockResolvedValue(null);
});

describe("POST /api/v1/accounts/:id/follow", () => {
  it("re-sends the Follow when the previous request was rejected", async () => {
    mocks.getFollow.mockResolvedValue({ id: "f1", actorId: LOCAL, targetId: REMOTE, state: "rejected", activityId: "old" });

    const res = await POST(request() as never, { params: Promise.resolve({ id: encodeURIComponent(REMOTE) }) });

    expect(res.status).toBe(200);
    const update = mocks.statements.find((s) => s.sql.startsWith("UPDATE follows SET state"));
    expect(update).toBeDefined();
    expect(update?.args[0]).toBe("accepted");
    expect(mocks.createFollow).not.toHaveBeenCalled();
    expect(mocks.enqueueDeliveries).toHaveBeenCalledTimes(1);
  });

  it("keeps the request pending for accounts that approve followers manually", async () => {
    mocks.getActorById.mockResolvedValue({
      id: REMOTE,
      username: "alice",
      domain: "remote.example",
      isLocal: false,
      inbox: "https://remote.example/inbox",
      manuallyApprovesFollowers: true,
    });
    mocks.getFollow.mockResolvedValue({ id: "f1", actorId: LOCAL, targetId: REMOTE, state: "rejected", activityId: "old" });

    await POST(request() as never, { params: Promise.resolve({ id: encodeURIComponent(REMOTE) }) });

    const update = mocks.statements.find((s) => s.sql.startsWith("UPDATE follows SET state"));
    expect(update?.args[0]).toBe("pending");
  });

  it("returns the relationship untouched for an existing accepted follow", async () => {
    mocks.getFollow.mockResolvedValue({ id: "f1", actorId: LOCAL, targetId: REMOTE, state: "accepted", activityId: "old" });

    const res = await POST(request() as never, { params: Promise.resolve({ id: encodeURIComponent(REMOTE) }) });

    expect(res.status).toBe(200);
    expect(mocks.statements).toHaveLength(0);
    expect(mocks.createFollow).not.toHaveBeenCalled();
    expect(mocks.enqueueDeliveries).not.toHaveBeenCalled();
  });

  it("creates a fresh follow for a new account", async () => {
    const res = await POST(request() as never, { params: Promise.resolve({ id: encodeURIComponent(REMOTE) }) });

    expect(res.status).toBe(200);
    expect(mocks.createFollow).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueDeliveries).toHaveBeenCalledTimes(1);
  });
});
