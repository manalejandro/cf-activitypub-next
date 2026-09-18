// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  getBaseUrl: vi.fn(() => "https://local.example"),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10 })),
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
  // db
  getActorByEmail: vi.fn(),
  createPasswordReset: vi.fn(async () => {}),
  getPasswordResetByToken: vi.fn(),
  markPasswordResetUsed: vi.fn(async () => {}),
  updatePassword: vi.fn(async () => {}),
  deleteOAuthTokensForActor: vi.fn(async () => {}),
  getOAuthAppByClientId: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  createOAuthToken: vi.fn(async () => {}),
  mediaCacheId: vi.fn(async (s: string) => `hash-${s}`),
  // auth
  hashPassword: vi.fn(async () => "hash"),
  verifyPassword: vi.fn(async () => true),
  generateSecureToken: vi.fn(() => "secure-token"),
  setAuthCookie: vi.fn(() => "auth=token; Path=/"),
  // email
  sendPasswordResetEmail: vi.fn(async () => {}),
  verifyTurnstileToken: vi.fn<(token?: string | null, options?: unknown) => Promise<{ success: boolean }>>(async () => ({ success: true })),
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
  getBaseUrl: mocks.getBaseUrl,
  checkRateLimit: mocks.checkRateLimit,
  json: mocks.json,
}));
vi.mock("@/lib/db", () => ({
  getActorByEmail: mocks.getActorByEmail,
  createPasswordReset: mocks.createPasswordReset,
  getPasswordResetByToken: mocks.getPasswordResetByToken,
  markPasswordResetUsed: mocks.markPasswordResetUsed,
  updatePassword: mocks.updatePassword,
  deleteOAuthTokensForActor: mocks.deleteOAuthTokensForActor,
  getOAuthAppByClientId: mocks.getOAuthAppByClientId,
  createOAuthToken: mocks.createOAuthToken,
  mediaCacheId: mocks.mediaCacheId,
}));
vi.mock("@/lib/auth", () => ({
  hashPassword: mocks.hashPassword,
  verifyPassword: mocks.verifyPassword,
  generateSecureToken: mocks.generateSecureToken,
  setAuthCookie: mocks.setAuthCookie,
}));
vi.mock("@/lib/email", () => ({ sendPasswordResetEmail: mocks.sendPasswordResetEmail }));
vi.mock("@/lib/turnstile", () => ({
  verifyTurnstileToken: mocks.verifyTurnstileToken,
  enforceTurnstilePolicy: async (o: { secret?: string; token?: string | null }) => {
    if (!o.secret) return { success: true, skipped: true };
    if (!o.token) return { success: false, errorCodes: ["missing-input-response"] };
    return mocks.verifyTurnstileToken(o.token, o);
  },
}));

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://local.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCloudflareContext.mockReturnValue({
    env: {
      DB: {},
      KV: { get: vi.fn(), put: vi.fn(), delete: vi.fn(async () => {}) },
      EMAIL: {},
      FROM_EMAIL: "noreply@local.example",
      INSTANCE_TITLE: "Test",
      TURNSTILE_SECRET: "secret",
    },
  });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10 });
  mocks.verifyPassword.mockResolvedValue(true);
});

describe("POST /api/auth/forgot-password", () => {
  it("rejects a tokenless request when Turnstile is configured", async () => {
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(post("/api/auth/forgot-password", { email: "user@example.com" }) as never);
    expect(res.status).toBe(422);
    expect((await res.json() as { error_code: string }).error_code).toBe("turnstile_error");
    expect(mocks.createPasswordReset).not.toHaveBeenCalled();
    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("sends the reset email with a valid token", async () => {
    mocks.getActorByEmail.mockResolvedValue({ id: "https://local.example/users/user", isLocal: true });
    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(
      post("/api/auth/forgot-password", { email: "user@example.com", "cf-turnstile-response": "tok" }) as never
    );
    expect(res.status).toBe(200);
    expect(mocks.createPasswordReset).toHaveBeenCalledTimes(1);
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("rejects a tokenless request when Turnstile is configured", async () => {
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(post("/api/auth/reset-password", { token: "reset", password: "password123" }) as never);
    expect(res.status).toBe(422);
    expect((await res.json() as { error_code: string }).error_code).toBe("turnstile_error");
    expect(mocks.updatePassword).not.toHaveBeenCalled();
  });

  it("resets the password and revokes sessions with a valid token", async () => {
    mocks.getPasswordResetByToken.mockResolvedValue({
      actorId: "https://local.example/users/user",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { POST } = await import("@/app/api/auth/reset-password/route");
    const res = await POST(
      post("/api/auth/reset-password", {
        token: "reset",
        password: "password123",
        "cf-turnstile-response": "tok",
      }) as never
    );
    expect(res.status).toBe(200);
    expect(mocks.updatePassword).toHaveBeenCalledTimes(1);
    expect(mocks.deleteOAuthTokensForActor).toHaveBeenCalledTimes(1);
    expect(mocks.markPasswordResetUsed).toHaveBeenCalledTimes(1);
  });
});

describe("POST /oauth/token (password grant)", () => {
  it("rejects a tokenless web login without a registered app", async () => {
    const { POST } = await import("@/app/oauth/token/route");
    const res = await POST(
      post("/oauth/token", { grant_type: "password", username: "user", password: "secret" }) as never
    );
    expect(res.status).toBe(401);
    expect((await res.json() as { error_code: string }).error_code).toBe("turnstile_error");
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("lets a registered API client skip the captcha", async () => {
    mocks.getActorByEmail.mockResolvedValue({
      id: "https://local.example/users/user",
      emailVerified: true,
      passwordHash: "hash",
    });
    mocks.getOAuthAppByClientId.mockResolvedValue({
      id: "app-1",
      clientId: "cid",
      clientSecret: "csecret",
      scopes: "read write",
    });
    const { POST } = await import("@/app/oauth/token/route");
    const res = await POST(
      post("/oauth/token", {
        grant_type: "password",
        username: "user",
        password: "secret",
        client_id: "cid",
        client_secret: "csecret",
      }) as never
    );
    expect(res.status).toBe(200);
    expect(mocks.verifyTurnstileToken).not.toHaveBeenCalled();
    expect(mocks.createOAuthToken).toHaveBeenCalledTimes(1);
  });

  it("locks an account after repeated failed passwords (IP-independent)", async () => {
    mocks.getActorByEmail.mockResolvedValue({
      id: "https://local.example/users/user",
      emailVerified: true,
      passwordHash: "hash",
    });
    mocks.verifyPassword.mockResolvedValue(false);
    // First call is the per-IP limit; the second is the per-account lockout.
    mocks.checkRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 9 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const { POST } = await import("@/app/oauth/token/route");
    const res = await POST(
      post("/oauth/token", {
        grant_type: "password",
        username: "user",
        password: "wrong",
        "cf-turnstile-response": "tok",
      }) as never
    );
    expect(res.status).toBe(429);
    expect((await res.json() as { error_code: string }).error_code).toBe("login_error_rate_limited");
  });
});
