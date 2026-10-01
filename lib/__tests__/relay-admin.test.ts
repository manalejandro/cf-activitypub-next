// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  getBaseUrl: vi.fn(() => "https://cf-ap.com"),
  getAdminRole: vi.fn(),
  requireAdmin: vi.fn(),
  listRelays: vi.fn(async (): Promise<unknown> => []),
  getRelayByInbox: vi.fn(async (): Promise<unknown> => null),
  createRelay: vi.fn(async (): Promise<unknown> => null),
  getRelayById: vi.fn(async (): Promise<unknown> => null),
  deleteRelay: vi.fn(async () => {}),
  enableRelay: vi.fn(async (): Promise<unknown> => null),
  disableRelay: vi.fn(async (): Promise<unknown> => null),
  normalizeRelayInbox: vi.fn((v: string) => (v.includes("://") ? v : null)),
  recordModeration: vi.fn(async () => {}),
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
  getBaseUrl: mocks.getBaseUrl,
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  badRequest: (message = "Bad request") =>
    new Response(JSON.stringify({ error: message }), { status: 422, headers: { "Content-Type": "application/json" } }),
}));
vi.mock("@/lib/admin-auth", () => ({
  getAdminRole: mocks.getAdminRole,
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/db", () => ({
  listRelays: mocks.listRelays,
  getRelayByInbox: mocks.getRelayByInbox,
  createRelay: mocks.createRelay,
  getRelayById: mocks.getRelayById,
  deleteRelay: mocks.deleteRelay,
}));
vi.mock("@/lib/activitypub/relays", () => ({
  enableRelay: mocks.enableRelay,
  disableRelay: mocks.disableRelay,
  normalizeRelayInbox: mocks.normalizeRelayInbox,
}));
vi.mock("@/lib/moderation/log", () => ({ recordModeration: mocks.recordModeration }));

import { GET, POST } from "@/app/api/v1/admin/relays/route";

const RELAY = {
  id: "r1",
  inboxUrl: "https://relay.example/inbox",
  actorUri: null,
  state: "idle" as const,
  followActivityId: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("https://cf-ap.com/api/v1/admin/relays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCloudflareContext.mockReturnValue({ env: { DB: {} } });
  mocks.getBaseUrl.mockReturnValue("https://cf-ap.com");
  mocks.requireAdmin.mockResolvedValue(true);
  mocks.getAdminRole.mockResolvedValue("admin");
  mocks.listRelays.mockResolvedValue([RELAY]);
  mocks.getRelayByInbox.mockResolvedValue(null);
  mocks.createRelay.mockResolvedValue(RELAY);
  mocks.getRelayById.mockResolvedValue(RELAY);
  mocks.enableRelay.mockResolvedValue({ ...RELAY, state: "pending" });
  mocks.disableRelay.mockResolvedValue(RELAY);
  mocks.normalizeRelayInbox.mockImplementation((v: string) => (v.startsWith("https://") ? v : null));
});

describe("GET /api/v1/admin/relays", () => {
  it("rejects anonymous callers", async () => {
    mocks.requireAdmin.mockResolvedValue(false);
    const res = await GET(makeRequest({}) as never);
    expect(res.status).toBe(401);
  });

  it("lists relays for an admin", async () => {
    const res = await GET(makeRequest({}) as never);
    expect(res.status).toBe(200);
    expect((await res.json() as { relays: unknown[] }).relays).toHaveLength(1);
  });
});

describe("POST /api/v1/admin/relays", () => {
  it("rejects moderators (full admin required)", async () => {
    mocks.getAdminRole.mockResolvedValue("moderator");
    const res = await POST(makeRequest({ inbox_url: "https://relay.example/inbox" }) as never);
    expect(res.status).toBe(403);
    expect(mocks.createRelay).not.toHaveBeenCalled();
  });

  it("rejects an invalid inbox URL", async () => {
    const res = await POST(makeRequest({ inbox_url: "ftp://relay.example" }) as never);
    expect(res.status).toBe(422);
    expect(mocks.createRelay).not.toHaveBeenCalled();
  });

  it("adds a relay and audits it", async () => {
    const res = await POST(makeRequest({ inbox_url: "https://relay.example/inbox" }) as never);
    expect(res.status).toBe(200);
    expect(mocks.createRelay).toHaveBeenCalledTimes(1);
    expect(mocks.recordModeration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "relay_added", targetType: "relay" })
    );
  });

  it("does not duplicate an already known relay", async () => {
    mocks.getRelayByInbox.mockResolvedValue(RELAY);
    const res = await POST(makeRequest({ inbox_url: "https://relay.example/inbox" }) as never);
    expect(res.status).toBe(200);
    expect(mocks.createRelay).not.toHaveBeenCalled();
    expect(mocks.recordModeration).not.toHaveBeenCalled();
  });

  it("enables a relay", async () => {
    const res = await POST(makeRequest({ id: "r1", action: "enable" }) as never);
    expect(res.status).toBe(200);
    expect(mocks.enableRelay).toHaveBeenCalledTimes(1);
    expect(mocks.recordModeration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "relay_enabled" })
    );
  });

  it("fails when no signing actor exists", async () => {
    mocks.enableRelay.mockResolvedValue(null);
    const res = await POST(makeRequest({ id: "r1", action: "enable" }) as never);
    expect(res.status).toBe(500);
  });

  it("disables an accepted relay", async () => {
    mocks.getRelayById.mockResolvedValue({ ...RELAY, state: "accepted" });
    const res = await POST(makeRequest({ id: "r1", action: "disable" }) as never);
    expect(res.status).toBe(200);
    expect(mocks.disableRelay).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes before removing an accepted relay", async () => {
    mocks.getRelayById.mockResolvedValue({ ...RELAY, state: "accepted" });
    const res = await POST(makeRequest({ id: "r1", action: "remove" }) as never);
    expect(res.status).toBe(200);
    expect(mocks.disableRelay).toHaveBeenCalledTimes(1);
    expect(mocks.deleteRelay).toHaveBeenCalledWith(expect.anything(), "r1");
  });

  it("404s for an unknown relay", async () => {
    mocks.getRelayById.mockResolvedValue(null);
    const res = await POST(makeRequest({ id: "nope", action: "disable" }) as never);
    expect(res.status).toBe(404);
  });

  it("rejects unknown actions", async () => {
    const res = await POST(makeRequest({ id: "r1", action: "explode" }) as never);
    expect(res.status).toBe(422);
  });
});
