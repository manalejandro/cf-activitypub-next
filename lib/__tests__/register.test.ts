// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  getBaseUrl: vi.fn(() => "https://local.example"),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10 })),
  getActorByEmail: vi.fn(async () => null),
  createActor: vi.fn(async () => {}),
  createOAuthToken: vi.fn(async () => {}),
  getOAuthAppByClientId: vi.fn(async () => null),
  createEmailVerification: vi.fn(async () => {}),
  getRegistrationSettings: vi.fn(async () => ({
    enabled: true,
    approvalRequired: false,
    reasonRequired: false,
    message: null,
    minAge: null,
    url: null,
  })),
  generateKeyPair: vi.fn(async () => ({ publicKeyPem: "pub", privateKeyPem: "priv" })),
  actorIRI: vi.fn(() => "https://local.example/users/newbie"),
  hashPassword: vi.fn(async () => "hash"),
  generateSecureToken: vi.fn(() => "token123"),
  verifyTurnstileToken: vi.fn(async () => ({ success: true })),
  sendVerificationEmail: vi.fn(async () => {}),
  evaluateRegistration: vi.fn(async () => null),
  rejectAccount: vi.fn(async () => {}),
  approveAccount: vi.fn(async () => {}),
  runWithTimeout: vi.fn(async (fn: unknown) => fn),
  chargeGlobalAI: vi.fn(async () => false),
  computeRegistrationSignals: vi.fn(() => ({ flags: [] })),
}));

vi.mock("@/lib/cf", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
  getBaseUrl: mocks.getBaseUrl,
  checkRateLimit: mocks.checkRateLimit,
  json: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }),
}));
vi.mock("@/lib/db", () => ({
  getActorByEmail: mocks.getActorByEmail,
  createActor: mocks.createActor,
  createOAuthToken: mocks.createOAuthToken,
  getOAuthAppByClientId: mocks.getOAuthAppByClientId,
  createEmailVerification: mocks.createEmailVerification,
  getRegistrationSettings: mocks.getRegistrationSettings,
}));
vi.mock("@/lib/activitypub/security", () => ({ generateKeyPair: mocks.generateKeyPair }));
vi.mock("@/lib/activitypub/utils", () => ({ actorIRI: mocks.actorIRI }));
vi.mock("@/lib/auth", () => ({
  hashPassword: mocks.hashPassword,
  generateSecureToken: mocks.generateSecureToken,
}));
vi.mock("@/lib/turnstile", () => ({ verifyTurnstileToken: mocks.verifyTurnstileToken }));
vi.mock("@/lib/email", () => ({ sendVerificationEmail: mocks.sendVerificationEmail }));
vi.mock("@/lib/moderation/ai", () => ({ evaluateRegistration: mocks.evaluateRegistration }));
vi.mock("@/lib/moderation/actions", () => ({
  rejectAccount: mocks.rejectAccount,
  approveAccount: mocks.approveAccount,
  GUARDIAN_MODEL: "guardian",
}));
vi.mock("@/lib/moderation/util", () => ({ runWithTimeout: mocks.runWithTimeout }));
vi.mock("@/lib/moderation/budget", () => ({
  chargeGlobalAI: mocks.chargeGlobalAI,
  AI_UNITS_REASON: "registration",
}));
vi.mock("@/lib/moderation/heuristics", () => ({
  computeRegistrationSignals: mocks.computeRegistrationSignals,
}));

const fakeDb = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      run: async () => ({}),
    }),
  }),
} as unknown as D1Database;

type RegisterBody = { access_token?: string; pending_verification?: boolean; pending_approval?: boolean; error?: string };

function registerRequest(body: Record<string, unknown>): Request {
  return new Request("https://local.example/api/v1/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function post(body: Record<string, unknown>): Promise<{ status: number; body: RegisterBody }> {
  const { POST } = await import("@/app/api/v1/accounts/route");
  const res = await POST(registerRequest(body) as never);
  return { status: res.status, body: (await res.json()) as RegisterBody };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCloudflareContext.mockReturnValue({
    env: {
      DB: fakeDb,
      KV: {},
      EMAIL: {},
      FROM_EMAIL: "noreply@local.example",
      INSTANCE_TITLE: "Test",
      TURNSTILE_SECRET: "secret",
    },
  });
  mocks.getRegistrationSettings.mockResolvedValue({
    enabled: true,
    approvalRequired: false,
    reasonRequired: false,
    message: null,
    minAge: null,
    url: null,
  });
  mocks.getActorByEmail.mockResolvedValue(null);
  mocks.verifyTurnstileToken.mockResolvedValue({ success: true });
});

describe("POST /api/v1/accounts", () => {
  it("never auto-verifies an API registration and sends the confirmation email", async () => {
    // No cf-turnstile-response: this is how a third-party app (or a bot) registers.
    const { status, body } = await post({ username: "newbie", email: "new@example.com", password: "password123" });

    expect(status).toBe(200);
    expect(mocks.createActor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ emailVerified: false })
    );
    expect(mocks.createEmailVerification).toHaveBeenCalledTimes(1);
    expect(mocks.sendVerificationEmail).toHaveBeenCalledTimes(1);
    // Mastodon-compatible: the token is issued but stays unusable until the
    // address is confirmed (see getAuthenticatedActor).
    expect(body.access_token).toBe("token123");
  });

  it("keeps the web flow pending verification without a token", async () => {
    const { status, body } = await post({
      username: "newbie",
      email: "new@example.com",
      password: "password123",
      "cf-turnstile-response": "turnstile-token",
    });

    expect(status).toBe(200);
    expect(body.pending_verification).toBe(true);
    expect(body.access_token).toBeUndefined();
    expect(mocks.createActor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ emailVerified: false })
    );
    expect(mocks.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("still sends the email when the instance requires admin approval", async () => {
    mocks.getRegistrationSettings.mockResolvedValue({
      enabled: true,
      approvalRequired: true,
      reasonRequired: false,
      message: null,
      minAge: null,
      url: null,
    });

    const { status, body } = await post({
      username: "newbie",
      email: "new@example.com",
      password: "password123",
    });

    expect(status).toBe(200);
    expect(body.pending_approval).toBe(true);
    expect(body.access_token).toBeUndefined();
    expect(mocks.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });
});
