import { type NextRequest } from "next/server";
import { getCloudflareContext, json, checkRateLimit } from "@/lib/cf";
import { deleteOAuthTokensForActor, getPasswordResetByToken, markPasswordResetUsed, updatePassword } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { getBaseUrl } from "@/lib/cf";
import { enforceTurnstilePolicy } from "@/lib/turnstile";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";

export async function POST(request: NextRequest): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  let token: string;
  let password: string;
  let turnstileToken: string | null = null;

  if (contentType.includes("application/json")) {
    const body = await request.json() as { token?: string; password?: string; "cf-turnstile-response"?: string };
    token = (body.token ?? "").trim();
    password = body.password ?? "";
    turnstileToken = body["cf-turnstile-response"] ?? null;
  } else {
    const form = await request.formData();
    token = ((form.get("token") as string | null) ?? "").trim();
    password = (form.get("password") as string | null) ?? "";
    turnstileToken = (form.get("cf-turnstile-response") as string | null) ?? null;
  }

  if (!token || !password) {
    return json({ error: "token and password are required" }, 400);
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return json({ error: "Password must be at least 8 characters" }, 422);
  }

  const { env } = getCloudflareContext();
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";

  const turnstile = await enforceTurnstilePolicy({
    secret: env.TURNSTILE_SECRET,
    token: turnstileToken,
    remoteIp: clientIp === "unknown" ? undefined : clientIp,
    expectedHostname: new URL(getBaseUrl(env)).hostname,
    expectedAction: "reset_password",
  });
  if (!turnstile.success) {
    return json({ error: "Security check failed. Please try again.", error_code: "turnstile_error" }, 422);
  }
  const { allowed } = await checkRateLimit(env.KV, `reset:${clientIp}`, 10, 60);
  if (!allowed) {
    return json({ error: "Too many requests. Please try again later." }, 429);
  }

  const record = await getPasswordResetByToken(env.DB, token);
  if (!record) {
    return json({ error: "Invalid or expired reset token" }, 400);
  }

  if (new Date(record.expiresAt) < new Date()) {
    await markPasswordResetUsed(env.DB, token);
    return json({ error: "This reset link has expired" }, 400);
  }

  const passwordHash = await hashPassword(password);
  await updatePassword(env.DB, record.actorId, passwordHash);
  // A password reset must evict every existing session/token (the usual
  // incident response when a session may have leaked).
  await deleteOAuthTokensForActor(env.DB, record.actorId);
  await markPasswordResetUsed(env.DB, token);

  return json({ ok: true });
}
