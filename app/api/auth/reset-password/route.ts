import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getPasswordResetByToken, markPasswordResetUsed, updatePassword } from "@/lib/db";
import { hashPassword } from "@/lib/auth";

export async function POST(request: NextRequest): Promise<Response> {
  const contentType = request.headers.get("Content-Type") ?? "";
  let token: string;
  let password: string;

  if (contentType.includes("application/json")) {
    const body = await request.json() as { token?: string; password?: string };
    token = (body.token ?? "").trim();
    password = body.password ?? "";
  } else {
    const form = await request.formData();
    token = ((form.get("token") as string | null) ?? "").trim();
    password = (form.get("password") as string | null) ?? "";
  }

  if (!token || !password) {
    return json({ error: "token and password are required" }, 400);
  }

  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters" }, 422);
  }

  const { env } = getCloudflareContext();

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
  await markPasswordResetUsed(env.DB, token);

  return json({ ok: true });
}
