import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { env } from "cloudflare:workers";

export async function GET(request: NextRequest): Promise<Response> {
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  return json({ email: me.email ?? "", email_verified: me.emailVerified });
}
