import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl, json, checkRateLimit } from "@/lib/cf";
import { getActorByEmail, createPasswordReset } from "@/lib/db";
import { generateSecureToken } from "@/lib/auth";
import { sendPasswordResetEmail } from "@/lib/email";
import { enforceTurnstilePolicy } from "@/lib/turnstile";

export async function POST(request: NextRequest): Promise<Response> {
  let email: string;
  let turnstileToken: string | null = null;

  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json() as { email?: string; "cf-turnstile-response"?: string };
    email = (body.email ?? "").trim().toLowerCase();
    turnstileToken = body["cf-turnstile-response"] ?? null;
  } else {
    const form = await request.formData();
    email = ((form.get("email") as string | null) ?? "").trim().toLowerCase();
    turnstileToken = (form.get("cf-turnstile-response") as string | null) ?? null;
  }

  if (!email) {
    return json({ error: "email is required" }, 400);
  }

  const { env } = getCloudflareContext();
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";

  // Recovery is browser-only: bots were able to omit the token and skip the
  // challenge entirely, spamming reset emails. Mandatory when configured.
  const turnstile = await enforceTurnstilePolicy({
    secret: env.TURNSTILE_SECRET,
    token: turnstileToken,
    remoteIp: clientIp === "unknown" ? undefined : clientIp,
    expectedHostname: new URL(getBaseUrl(env)).hostname,
    expectedAction: "forgot_password",
  });
  if (!turnstile.success) {
    return json({ error: "Security check failed. Please try again.", error_code: "turnstile_error" }, 422);
  }
  const { allowed } = await checkRateLimit(env.KV, `forgot:${clientIp}`, 5, 60);
  if (!allowed) {
    return json({ error: "Too many requests. Please try again later." }, 429);
  }

  // Silently succeed if account not found — prevents email enumeration
  const actor = await getActorByEmail(env.DB, email);
  if (actor?.isLocal) {
    const token = generateSecureToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    await createPasswordReset(env.DB, actor.id, token, expiresAt);

    const baseUrl = getBaseUrl(env);
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;

    try {
      await sendPasswordResetEmail(env.EMAIL, {
        to: email,
        from: env.FROM_EMAIL,
        resetUrl,
        instanceTitle: env.INSTANCE_TITLE,
      });
    } catch {
      console.error("[forgot-password] Failed to send email to", email);
    }
  }

  return json({ ok: true });
}
