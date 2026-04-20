import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getActorByEmail, getOAuthAppByClientId, createOAuthToken } from "@/lib/db";
import { verifyPassword, generateSecureToken } from "@/lib/auth";

// POST /oauth/token
export async function POST(request: NextRequest): Promise<Response> {
  let body: Record<string, string> = {};
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    const form = await request.formData();
    body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  }

  const { env } = getCloudflareContext();
  const grantType = body.grant_type;

  if (grantType === "password") {
    const { username, password, client_id, client_secret } = body;
    if (!username || !password) {
      return json({ error: "username and password are required" }, 400);
    }

    const actor = await getActorByEmail(env.DB, username.toLowerCase());
    if (!actor || !actor.passwordHash) {
      return json({ error: "invalid_grant", error_description: "Invalid credentials" }, 401);
    }

    const valid = await verifyPassword(password, actor.passwordHash);
    if (!valid) {
      return json({ error: "invalid_grant", error_description: "Invalid credentials" }, 401);
    }

    const app = client_id ? await getOAuthAppByClientId(env.DB, client_id) : null;

    const accessToken = generateSecureToken();
    const refreshToken = generateSecureToken();
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600 * 24 * 30; // 30 days

    await createOAuthToken(env.DB, {
      id: accessToken,
      appId: app?.id ?? "default",
      actorId: actor.id,
      accessToken,
      refreshToken,
      scope: body.scope ?? "read write follow push",
      expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    return json({
      access_token: accessToken,
      token_type: "Bearer",
      scope: body.scope ?? "read write follow push",
      created_at: now,
    });
  }

  if (grantType === "client_credentials") {
    const { client_id, client_secret } = body;
    if (!client_id || !client_secret) {
      return json({ error: "client_id and client_secret are required" }, 400);
    }

    const app = await getOAuthAppByClientId(env.DB, client_id);
    if (!app || app.clientSecret !== client_secret) {
      return json({ error: "invalid_client", error_description: "Invalid client credentials" }, 401);
    }

    const accessToken = generateSecureToken();
    const now = Math.floor(Date.now() / 1000);

    await createOAuthToken(env.DB, {
      id: accessToken,
      appId: app.id,
      actorId: null,
      accessToken,
      refreshToken: null,
      scope: body.scope ?? "read",
      expiresAt: new Date((now + 3600) * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    return json({
      access_token: accessToken,
      token_type: "Bearer",
      scope: body.scope ?? "read",
      created_at: now,
    });
  }

  return json({ error: "unsupported_grant_type" }, 400);
}
