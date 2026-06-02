import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl, json } from "@/lib/cf";
import { getActorByEmail, createEmailVerification } from "@/lib/db";
import { generateSecureToken } from "@/lib/auth";
import { sendVerificationEmail } from "@/lib/email";

/**
 * POST /api/auth/resend-verification
 * Body: { email: string }
 *
 * Re-sends the verification email for an unverified account.
 * Always returns 200 to avoid leaking whether an email exists.
 */
export async function POST(request: NextRequest): Promise<Response> {
  let email: string;

  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json() as { email?: string };
    email = (body.email ?? "").trim().toLowerCase();
  } else {
    const form = await request.formData();
    email = ((form.get("email") as string | null) ?? "").trim().toLowerCase();
  }

  if (!email) {
    return json({ error: "email is required" }, 400);
  }

  const { env } = getCloudflareContext();

  // Silently succeed if account not found — prevents email enumeration
  const actor = await getActorByEmail(env.DB, email);
  if (!actor || !actor.isLocal || actor.emailVerified) {
    return json({ ok: true });
  }

  const token = generateSecureToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await createEmailVerification(env.DB, actor.id, token, expiresAt);

  const baseUrl = getBaseUrl(env);
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;

  try {
    await sendVerificationEmail(env.EMAIL, {
      to: email,
      from: env.FROM_EMAIL,
      verifyUrl,
      instanceTitle: env.INSTANCE_TITLE,
    });
  } catch {
    // Log but don't expose errors to prevent timing attacks
    console.error("[resend-verification] Failed to send email to", email);
  }

  return json({ ok: true });
}
