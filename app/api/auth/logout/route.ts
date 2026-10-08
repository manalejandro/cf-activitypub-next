import { type NextRequest } from "next/server";
import { clearAuthCookie, extractBearerToken } from "@/lib/auth";
import { deleteOAuthTokenByAccessToken } from "@/lib/db";
import { env } from "cloudflare:workers";

export async function POST(request: NextRequest): Promise<Response> {
  // Clearing the cookie isn't enough: revoke the token server-side so a copy
  // of it (or a stolen one) stops working immediately.
  const token = extractBearerToken(request);
  if (token) await deleteOAuthTokenByAccessToken(env.DB, token).catch(() => {});
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearAuthCookie(),
    },
  });
}
