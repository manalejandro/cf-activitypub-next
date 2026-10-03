// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  getActorByEmail: vi.fn(),
  getOAuthAppByClientId: vi.fn(),
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
  getCloudflareContext: mocks.getCloudflareContext,
  getBaseUrl: () => "https://cf-ap.com",
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/db", () => ({
  getActorByEmail: mocks.getActorByEmail,
  getOAuthAppByClientId: mocks.getOAuthAppByClientId,
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
  mocks.getCloudflareContext.mockReturnValue({
    env: {
      DB: {},
      KV: {
        get: async (k: string) => mocks.kv.get(k) ?? null,
        put: async (k: string, v: string) => { mocks.kv.set(k, v); },
        delete: async (k: string) => { mocks.kv.delete(k); },
      },
      TURNSTILE_SECRET: undefined,
    },
  });
  mocks.getOAuthAppByClientId.mockImplementation(async (_db: unknown, clientId: string) =>
    clientId === APP.clientId ? APP : null
  );
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
