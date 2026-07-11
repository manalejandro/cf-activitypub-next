import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl, json } from "@/lib/cf";
import { getActorByEmail, createPasswordReset } from "@/lib/db";
import { generateSecureToken } from "@/lib/auth";
import { sendPasswordResetEmail } from "@/lib/email";

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
