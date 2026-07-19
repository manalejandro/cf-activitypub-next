import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  return json({ email: me.email ?? "", email_verified: me.emailVerified });
}
