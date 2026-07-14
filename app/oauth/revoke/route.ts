import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { clearAuthCookie } from "@/lib/auth";

// POST /oauth/revoke  (RFC 7009)
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  let body: Record<string, string> = {};
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    const form = await request.formData();
    body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  }

  const token = body.token;
  if (!token) return json({ error: "invalid_request" }, 400);

  // Delete the token if it exists (RFC 7009 §2.2 — always return 200)
  await env.DB
    .prepare("DELETE FROM oauth_tokens WHERE access_token = ? OR refresh_token = ?")
    .bind(token, token)
    .run();

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearAuthCookie(),
    },
  });
}
