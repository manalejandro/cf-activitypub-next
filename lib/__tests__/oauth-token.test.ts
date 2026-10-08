// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  getActorByEmail: vi.fn(),
  getActorById: vi.fn(),
  getOAuthAppByClientId: vi.fn(),
  getOAuthAppById: vi.fn(),
  getOAuthTokenByRefreshToken: vi.fn(),
  refreshOAuthTokenAccessToken: vi.fn(async () => {}),
  createOAuthToken: vi.fn(async () => {}),
  mediaCacheId: vi.fn(async (v: string) => `id-${v}`),
  verifyPassword: vi.fn(async () => true),
  generateSecureToken: vi.fn(() => "tok"),
  setAuthCookie: vi.fn(() => "auth_token=x"),
  enforceTurnstilePolicy: vi.fn(async () => ({ success: true })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  kv: new Map<string, string>(),
}));

vi.mock("@/lib/cf", () => ({
  getBaseUrl: () => "https://cf-ap.com",
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("cloudflare:workers", () => ({ get env() { return mocks.env; } }));
vi.mock("@/lib/db", () => ({
  getActorByEmail: mocks.getActorByEmail,
  getActorById: mocks.getActorById,
  getOAuthAppByClientId: mocks.getOAuthAppByClientId,
  getOAuthAppById: mocks.getOAuthAppById,
  getOAuthTokenByRefreshToken: mocks.getOAuthTokenByRefreshToken,
  refreshOAuthTokenAccessToken: mocks.refreshOAuthTokenAccessToken,
  createOAuthToken: mocks.createOAuthToken,
  mediaCacheId: mocks.mediaCacheId,
}));
vi.mock("@/lib/auth", () => ({
  verifyPassword: mocks.verifyPassword,
  generateSecureToken: mocks.generateSecureToken,
  setAuthCookie: mocks.setAuthCookie,
}));
vi.mock("@/lib/turnstile", () => ({ enforceTurnstilePolicy: mocks.enforceTurnstilePolicy }));

import { POST } from "@/app/oauth/token/route";

const APP = {
  id: "app-uuid-1",
  name: "Test app",
  website: null,
  redirectUri: "https://client.example/cb",
  scopes: "read write follow",
  clientId: "client-abc",
  clientSecret: "secret-xyz",
  createdAt: "2026-10-03T00:00:00Z",
};

function makeRequest(params: Record<string, string>): Request {
  return new Request("https://cf-ap.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

function seedCode(code: string, payload: Record<string, unknown>) {
  mocks.kv.set(`oauth_code:${code}`, JSON.stringify(payload));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.kv.clear();
  mocks.env = {
    DB: {},
      KV: {
        get: async (k: string) => mocks.kv.get(k) ?? null,
        put: async (k: string, v: string) => { mocks.kv.set(k, v); },
        delete: async (k: string) => { mocks.kv.delete(k); },
      },
    TURNSTILE_SECRET: undefined,
  };
  mocks.getOAuthAppByClientId.mockImplementation(async (_db: unknown, clientId: string) =>
    clientId === APP.clientId ? APP : null
  );
  mocks.getOAuthAppById.mockImplementation(async (_db: unknown, appId: string) =>
    appId === APP.id ? APP : null
  );
  mocks.getActorById.mockResolvedValue({
    id: "https://cf-ap.com/users/me",
    isLocal: true,
    emailVerified: true,
    approved: true,
    suspended: false,
  });
});

describe("POST /oauth/token — authorization_code", () => {
  it("exchanges a code for a token when the client sends its client_id", async () => {
    seedCode("code-1", {
      actorId: "https://cf-ap.com/users/me",
      appId: APP.id,
      clientId: APP.clientId,
      scope: "read write",
      redirectUri: APP.redirectUri,
      codeChallenge: null,
      codeChallengeMethod: null,
    });

    const res = await POST(makeRequest({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: APP.redirectUri,
      client_id: APP.clientId,
    }) as never);

    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string; scope: string };
    expect(body.access_token).toBeTruthy();
    // Scopes are clamped to the app's registered scopes (read write follow).
    expect(body.scope).toBe("read write");
    expect(mocks.createOAuthToken).toHaveBeenCalledTimes(1);
    const [, token] = mocks.createOAuthToken.mock.calls[0] as unknown as [unknown, { appId: string; actorId: string }];
    expect(token.appId).toBe(APP.id);
    expect(token.actorId).toBe("https://cf-ap.com/users/me");
  });

  it("rejects a code presented by a different client", async () => {
    seedCode("code-2", {
      actorId: "https://cf-ap.com/users/me",
      appId: APP.id,
      clientId: APP.clientId,
      scope: "read",
      redirectUri: APP.redirectUri,
      codeChallenge: null,
      codeChallengeMethod: null,
    });

    const res = await POST(makeRequest({
      grant_type: "authorization_code",
      code: "code-2",
      redirect_uri: APP.redirectUri,
      client_id: "otra-app",
    }) as never);

    expect(res.status).toBe(400);
    expect(mocks.createOAuthToken).not.toHaveBeenCalled();
  });

  it("still exchanges codes minted before clientId was stored", async () => {
    seedCode("code-3", {
      actorId: "https://cf-ap.com/users/me",
      appId: APP.id,
      scope: "read",
      redirectUri: APP.redirectUri,
      codeChallenge: null,
      codeChallengeMethod: null,
    });

    const res = await POST(makeRequest({
      grant_type: "authorization_code",
      code: "code-3",
      redirect_uri: APP.redirectUri,
      client_id: APP.clientId,
    }) as never);

    expect(res.status).toBe(200);
  });
});

describe("POST /oauth/token — refresh_token", () => {
  const ROW = {
    id: "tok-1",
    actorId: "https://cf-ap.com/users/me",
    appId: APP.id,
    accessToken: "old-access",
    refreshToken: "refresh-1",
    scope: "read write",
    expiresAt: "2020-01-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
  };

  it("rotates the access token in place, keeping the refresh token and scope", async () => {
    mocks.getOAuthTokenByRefreshToken.mockResolvedValue(ROW);

    const res = await POST(makeRequest({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: APP.clientId,
      client_secret: APP.clientSecret,
    }) as never);

    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string; refresh_token: string; scope: string };
    expect(body.access_token).toBe("tok");
    expect(body.refresh_token).toBe("refresh-1");
    expect(body.scope).toBe("read write");
    expect(mocks.refreshOAuthTokenAccessToken).toHaveBeenCalledWith(expect.anything(), "tok-1", "tok", expect.any(String));
    expect(mocks.createOAuthToken).not.toHaveBeenCalled();
  });

  it("rejects an unknown or actor-less refresh token", async () => {
    mocks.getOAuthTokenByRefreshToken.mockResolvedValue(null);
    expect((await POST(makeRequest({ grant_type: "refresh_token", refresh_token: "nope" }) as never)).status).toBe(400);

    mocks.getOAuthTokenByRefreshToken.mockResolvedValue({ ...ROW, actorId: null });
    expect((await POST(makeRequest({ grant_type: "refresh_token", refresh_token: "refresh-1" }) as never)).status).toBe(400);
    expect(mocks.refreshOAuthTokenAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a refresh presented by a different client", async () => {
    mocks.getOAuthTokenByRefreshToken.mockResolvedValue(ROW);
    const res = await POST(makeRequest({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "otra-app",
    }) as never);
    expect(res.status).toBe(401);
    expect(mocks.refreshOAuthTokenAccessToken).not.toHaveBeenCalled();
  });

  it("refuses to refresh a suspended account", async () => {
    mocks.getOAuthTokenByRefreshToken.mockResolvedValue(ROW);
    mocks.getActorById.mockResolvedValue({ id: ROW.actorId, isLocal: true, emailVerified: true, approved: true, suspended: true });
    const res = await POST(makeRequest({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: APP.clientId,
      client_secret: APP.clientSecret,
    }) as never);
    expect(res.status).toBe(400);
    expect(mocks.refreshOAuthTokenAccessToken).not.toHaveBeenCalled();
  });
});
