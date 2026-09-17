import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl, json, checkRateLimit } from "@/lib/cf";
import { getActorByEmail, getOAuthAppByClientId, createOAuthToken } from "@/lib/db";
import { verifyPassword, generateSecureToken, setAuthCookie } from "@/lib/auth";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { clampScope } from "@/lib/oauth-scopes";

// POST /oauth/token — standard Mastodon OAuth token endpoint (also used by the
// web login form). External clients call this path directly.
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

  // Rate limit: 10 attempts per IP per 60s window
  const remoteIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { allowed } = await checkRateLimit(env.KV, `token:${remoteIp}`, 10, 60);
  if (!allowed) {
    return json({ error: "invalid_grant", error_description: "Too many requests. Please try again later." }, 429);
  }

  if (grantType === "password") {
    const { username, password, client_id, client_secret } = body;
    if (!username || !password) {
      return json({ error: "username and password are required" }, 400);
    }

    // If a Turnstile token is included (web form login), verify it.
    const turnstileToken = body["cf-turnstile-response"];
    if (turnstileToken) {
      const remoteIp = request.headers.get("CF-Connecting-IP") ?? undefined;
      const valid = await verifyTurnstileToken(turnstileToken, {
        secret: env.TURNSTILE_SECRET,
        remoteIp,
        expectedHostname: new URL(getBaseUrl(env)).hostname,
        expectedAction: "login",
      });
      if (!valid.success) {
        return json({ error: "invalid_grant", error_description: "Security check failed. Please try again." }, 401);
      }
    }

    const actor = await getActorByEmail(env.DB, username.toLowerCase());
    if (!actor || !actor.passwordHash) {
      return json({ error: "invalid_grant", error_description: "Invalid credentials" }, 401);
    }

    const valid = await verifyPassword(password, actor.passwordHash);
    if (!valid) {
      return json({ error: "invalid_grant", error_description: "Invalid credentials" }, 401);
    }

    // Block login for accounts that registered via the web form but haven't verified their email.
    if (!actor.emailVerified) {
      return json({
        error: "unverified_email",
        error_description: "Please verify your email address before signing in.",
      }, 403);
    }

    const app = client_id ? await getOAuthAppByClientId(env.DB, client_id) : null;

    // Verify client_secret if app was found
    if (app && client_secret && app.clientSecret !== client_secret) {
      return json({ error: "invalid_client", error_description: "Invalid client credentials" }, 401);
    }

    const grantedScope = clampScope(body.scope, app?.scopes, "read write follow push");

    const accessToken = generateSecureToken();
    const refreshToken = generateSecureToken();
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600 * 24 * 30; // 30 days

    await createOAuthToken(env.DB, {
      id: crypto.randomUUID(),
      appId: app?.id ?? null,
      actorId: actor.id,
      accessToken,
      refreshToken,
      scope: grantedScope,
      expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    // Only browsers on this origin get a session cookie: a cross-site form can
    // POST credentials but must not be able to log the victim into the
    // attacker's account (login CSRF). Native API clients send no Origin.
    const originHeader = request.headers.get("Origin");
    const sameOrigin = !originHeader || originHeader === new URL(request.url).origin;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sameOrigin) headers["Set-Cookie"] = setAuthCookie(accessToken);
    return new Response(JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      scope: grantedScope,
      created_at: now,
    }), { status: 200, headers });
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
      id: crypto.randomUUID(),
      appId: app.id,
      actorId: null,
      accessToken,
      refreshToken: null,
      scope: clampScope(body.scope, app.scopes, "read"),
      expiresAt: new Date((now + 3600) * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    return json({
      access_token: accessToken,
      token_type: "Bearer",
      scope: clampScope(body.scope, app.scopes, "read"),
      created_at: now,
    });
  }

  if (grantType === "authorization_code") {
    const { code, redirect_uri, client_id } = body;
    if (!code) return json({ error: "invalid_request", error_description: "code is required" }, 400);

    // Retrieve the auth code — consumed only after every check passes, so a
    // failed attempt cannot DoS the legitimate exchange.
    const raw = await env.KV.get(`oauth_code:${code}`);
    if (!raw) return json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" }, 400);

    let payload: {
      actorId: string;
      appId: string;
      scope: string;
      redirectUri: string;
      codeChallenge: string | null;
      codeChallengeMethod: string | null;
    };
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_grant" }, 400);
    }

    // The code was issued to one client: require that exact client_id and the
    // registered redirect_uri, so a leaked code alone is useless.
    if (client_id && client_id !== payload.appId) {
      return json({ error: "invalid_client", error_description: "client_id mismatch" }, 400);
    }
    if (redirect_uri !== payload.redirectUri) {
      return json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    }

    // PKCE: verify whenever the code was issued with a challenge (S256 by
    // default; plain is only accepted when the client explicitly asked).
    if (payload.codeChallenge) {
      const verifier = body.code_verifier;
      if (!verifier) return json({ error: "invalid_grant", error_description: "code_verifier required" }, 400);
      let computed = verifier;
      if (payload.codeChallengeMethod !== "plain") {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
        computed = btoa(String.fromCharCode(...new Uint8Array(hash)))
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      }
      if (computed !== payload.codeChallenge) {
        return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
      }
    }

    await env.KV.delete(`oauth_code:${code}`);

    const codeApp = await getOAuthAppByClientId(env.DB, payload.appId);
    const accessToken = generateSecureToken();
    const refreshToken = generateSecureToken();
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600 * 24 * 30;

    await createOAuthToken(env.DB, {
      id: crypto.randomUUID(),
      appId: payload.appId,
      actorId: payload.actorId,
      accessToken,
      refreshToken,
      scope: clampScope(payload.scope, codeApp?.scopes, "read"),
      expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    return json({
      access_token: accessToken,
      token_type: "Bearer",
      scope: clampScope(payload.scope, codeApp?.scopes, "read"),
      created_at: now,
    });
  }

  return json({ error: "unsupported_grant_type" }, 400);
}