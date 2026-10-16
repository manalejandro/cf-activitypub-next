import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { applyTestSchema, resetTestStorage } from "./helpers/db";

const aiMocks = vi.hoisted(() => ({
  evaluateRegistration: vi.fn(async () => null as { action: string; reason: string; confidence: string } | null),
}));

vi.mock("@/lib/moderation/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/ai")>()),
  evaluateRegistration: aiMocks.evaluateRegistration,
}));
// The vector memory needs the remote Vectorize binding: its own behaviour is
// covered by `lib/__tests__/vectors.test.ts` and `learn.test.ts`.
vi.mock("@/lib/moderation/vectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moderation/vectors")>()),
  vectorPreScreen: vi.fn(async () => ({ autoAction: null, flagged: false, best: null, precedent: null })),
  rememberAbuse: vi.fn(async () => true),
}));
// The mailer talks to a `send_email` binding that Miniflare cannot emulate.
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendVerificationEmail: vi.fn(async () => {}),
  sendModerationNoticeEmail: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => {}),
}));

import { POST as REGISTER } from "@/app/api/v1/accounts/route";

const db = env.DB;

function register(username: string, email: string): Promise<Response> {
  return REGISTER(
    new NextRequest("https://local.example.test/api/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password: "una-contraseña-larga" }),
    })
  );
}

async function logRow(username: string): Promise<{ action: string; source: string; confidence: string | null; details: Record<string, unknown>; target_id: string } | null> {
  const actor = await db
    .prepare("SELECT id FROM actors WHERE username = ?")
    .bind(username)
    .first<{ id: string }>();
  if (!actor) return null;
  return db
    .prepare("SELECT action, source, confidence, details, target_id FROM moderation_log WHERE target_id = ? ORDER BY created_at DESC")
    .bind(actor.id)
    .first<{ action: string; source: string; confidence: string | null; details: string; target_id: string }>()
    .then((row) => (row ? { ...row, details: JSON.parse(row.details) as Record<string, unknown> } : null));
}

beforeAll(async () => {
  await applyTestSchema();
});

beforeEach(async () => {
  await resetTestStorage();
  aiMocks.evaluateRegistration.mockReset().mockResolvedValue(null);
});

describe("the Guardian audits every registration", () => {
  it("records a clean registration with the heuristic verdict", async () => {
    const res = await register("newbie", "newbie@gmail.com");
    expect(res.status).toBe(200);

    const row = await logRow("newbie");
    expect(row).not.toBeNull();
    expect(row!.action).toBe("registration_reviewed");
    expect(row!.source).toBe("heuristic");
    expect(row!.details).toMatchObject({ stage: "registration", verdict: "allow", flags: [], pendingApproval: false });
    // Clean profiles never spend AI neurons.
    expect(aiMocks.evaluateRegistration).not.toHaveBeenCalled();
  });

  it("records the model's verdict and never verifies the mailbox", async () => {
    aiMocks.evaluateRegistration.mockResolvedValue({ action: "approve", reason: "Perfil legítimo.", confidence: "high" });

    const res = await register("freecrypto99", "freecrypto99@gmail.com");
    expect(res.status).toBe(200);

    const row = await logRow("freecrypto99");
    expect(row!.action).toBe("registration_reviewed");
    expect(row!.source).toBe("ai");
    expect(row!.confidence).toBe("high");
    expect(row!.details).toMatchObject({ verdict: "approve" });
    expect(row!.details.flags).toEqual(["username_sospechoso"]);

    // The AI's approval must not confirm the email: only the link does.
    const actor = await db
      .prepare("SELECT email_verified FROM actors WHERE username = 'freecrypto99'")
      .first<{ email_verified: number }>();
    expect(actor!.email_verified).toBe(0);
  });

  it("flags a review that produced no verdict instead of dropping it silently", async () => {
    aiMocks.evaluateRegistration.mockResolvedValue(null);

    await register("freecrypto99", "freecrypto99@gmail.com");

    const row = await logRow("freecrypto99");
    expect(row!.action).toBe("registration_reviewed");
    expect(row!.source).toBe("ai");
    expect(row!.confidence).toBe("low");
    expect(row!.details).toMatchObject({ verdict: "unreviewed" });
  });

  it("records a rejection and removes the account", async () => {
    aiMocks.evaluateRegistration.mockResolvedValue({ action: "reject", reason: "Spam.", confidence: "high" });

    const res = await register("freecrypto99", "freecrypto99@gmail.com");
    expect(res.status).toBe(422);

    const actor = await db
      .prepare("SELECT id FROM actors WHERE username = 'freecrypto99'")
      .first<{ id: string }>();
    expect(actor).toBeNull();
    const row = await db
      .prepare("SELECT action, details FROM moderation_log WHERE action = 'rejected'")
      .first<{ action: string; details: string }>();
    expect(row!.action).toBe("rejected");
    expect(JSON.parse(row!.details)).toMatchObject({ verdict: "reject" });
  });

  it("records a blocked registration attempt", async () => {
    const res = await register("botuser", "botuser@mailinator.com");
    expect(res.status).toBe(422);

    const row = await db
      .prepare("SELECT action, source, target_type FROM moderation_log WHERE action = 'registration_blocked'")
      .first<{ action: string; source: string; target_type: string }>();
    expect(row).toMatchObject({ action: "registration_blocked", source: "heuristic", target_type: "email" });
  });
});
