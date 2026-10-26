// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  getActorByEmail: vi.fn(),
  getOAuthAppByClientId: vi.fn(),
  mediaCacheId: vi.fn(async (v: string) => `id-${v}`),
  verifyPassword: vi.fn(async () => true),
  generateSecureToken: vi.fn(() => "code-tok"),
  hashPassword: vi.fn(async () => "pbkdf2:600000:aa:bb"),
  needsPasswordRehash: vi.fn(() => false),
  updatePassword: vi.fn(async () => {}),
  enforceTurnstilePolicy: vi.fn(async () => ({ success: true })),
  checkRateLimit:
    vi.fn<(kv: unknown, key: string) => Promise<{ allowed: boolean; blocked: boolean }>>(
      async () => ({ allowed: true, blocked: false })
    ),
  kv: new Map<string, string>(),
}));

vi.mock("@/lib/cf", () => ({
  getBaseUrl: () => "https://cf-ap.com",
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("cloudflare:workers", () => ({ get env() { return mocks.env; } }));
vi.mock("@/lib/db", () => ({
  getActorByEmail: mocks.getActorByEmail,
  getOAuthAppByClientId: mocks.getOAuthAppByClientId,
  updatePassword: mocks.updatePassword,
  mediaCacheId: mocks.mediaCacheId,
}));
vi.mock("@/lib/auth", () => ({
  verifyPassword: mocks.verifyPassword,
  generateSecureToken: mocks.generateSecureToken,
  hashPassword: mocks.hashPassword,
  needsPasswordRehash: mocks.needsPasswordRehash,
  timingSafeEqualStr: (a: string, b: string) => a === b,
}));
vi.mock("@/lib/turnstile", () => ({ enforceTurnstilePolicy: mocks.enforceTurnstilePolicy }));

import { POST } from "@/app/api/oauth/authorize/route";

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

const ME = {
  id: "https://cf-ap.com/users/me",
  isLocal: true,
  emailVerified: true,
  approved: true,
  suspended: false,
  memorial: false,
  passwordHash: "hash",
};

function makeRequest(fields: Record<string, string> = {}): Request {
  const form = new FormData();
  form.set("client_id", APP.clientId);
  form.set("redirect_uri", APP.redirectUri);
  form.set("scope", "read write");
  form.set("state", "st1");
  form.set("action", "authorize");
  form.set("email", "me@cf-ap.com");
  form.set("password", "correct horse");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("https://cf-ap.com/api/oauth/authorize", { method: "POST", body: form });
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
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, blocked: false });
  mocks.enforceTurnstilePolicy.mockResolvedValue({ success: true });
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.getOAuthAppByClientId.mockImplementation(async (_db: unknown, clientId: string) =>
    clientId === APP.clientId ? APP : null
  );
  mocks.getActorByEmail.mockResolvedValue({ ...ME });
});

describe("POST /api/oauth/authorize (consent form)", () => {
  it("issues a code and redirects back to the app on success", async () => {
    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin).toBe("https://client.example");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(mocks.kv.has(`oauth_code:${code}`)).toBe(true);
  });

  it("refuses a suspended account", async () => {
    mocks.getActorByEmail.mockResolvedValue({ ...ME, suspended: true });
    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("suspended");
    expect(mocks.kv.size).toBe(0);
  });

  it("refuses a memorialized account", async () => {
    mocks.getActorByEmail.mockResolvedValue({ ...ME, memorial: true });
    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("memorialized");
  });

  it("redirects with an error on a wrong password", async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("Invalid+credentials");
  });

  it("locks the account before verifying when the failure budget is spent", async () => {
    mocks.checkRateLimit.mockImplementation(async (_kv: unknown, key: string) =>
      key.startsWith("login-fail:") ? { allowed: false, blocked: false } : { allowed: true, blocked: false }
    );
    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("Too+many+failed+attempts");
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("requires a solved Turnstile challenge when the instance configures one", async () => {
    mocks.env = { ...mocks.env, TURNSTILE_SECRET: "secret" };
    mocks.enforceTurnstilePolicy.mockResolvedValue({ success: false });
    const res = await POST(makeRequest() as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("Security+check+failed");
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("passes the form's turnstile token and login action to the policy", async () => {
    mocks.env = { ...mocks.env, TURNSTILE_SECRET: "secret" };
    await POST(makeRequest({ "cf-turnstile-response": "tok-1" }) as never);
    expect(mocks.enforceTurnstilePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ secret: "secret", token: "tok-1", expectedAction: "login" })
    );
  });

  it("rejects an unknown client before touching credentials", async () => {
    const res = await POST(makeRequest({ client_id: "nope" }) as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("Invalid+client");
    expect(mocks.getActorByEmail).not.toHaveBeenCalled();
  });
});
