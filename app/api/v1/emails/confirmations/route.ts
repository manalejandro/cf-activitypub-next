import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const body = await request.json() as { email?: string };
  if (!body.email) return json({ error: "Email is required" }, 400);
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB
    .prepare("INSERT INTO email_verifications (id, actor_id, token, expires_at) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), me.id, token, expiresAt)
    .run();
  return json({});
}
