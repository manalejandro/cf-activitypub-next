import { type NextRequest } from "next/server";
import { getBaseUrl, json, checkRateLimit } from "@/lib/cf";
import { getActorByEmail, getActorById, getOAuthAppByClientId, getOAuthAppById, getOAuthTokenByRefreshToken, createOAuthToken, mediaCacheId, refreshOAuthTokenAccessToken } from "@/lib/db";
import { verifyPassword, generateSecureToken, setAuthCookie } from "@/lib/auth";
import { enforceTurnstilePolicy } from "@/lib/turnstile";
import { clampScope } from "@/lib/oauth-scopes";
import { env } from "cloudflare:workers";

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

  const grantType = body.grant_type;

  // Rate limit: 10 attempts per IP per 60s window
  const remoteIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { allowed } = await checkRateLimit(env.KV, `token:${remoteIp}`, 10, 60);
  if (!allowed) {
    return json({ error: "invalid_grant", error_description: "Too many requests. Please try again later.", error_code: "login_error_rate_limited" }, 429);
  }

  if (grantType === "password") {
    const { username, password, client_id, client_secret } = body;
    if (!username || !password) {
      return json({ error: "username and password are required", error_code: "login_error_fields_required" }, 400);
    }

    // API clients (Mastodon apps) identify with a registered app's
    // client_id/client_secret; browser logins must pass the captcha whenever
    // the instance has one configured. Verifying only when a token happened to
    // be present let a bot skip the challenge by omitting it.
    const turnstileToken = body["cf-turnstile-response"];
    let apiClient = false;
    if (client_id && client_secret) {
      const app = await getOAuthAppByClientId(env.DB, client_id);
      apiClient = Boolean(app?.clientSecret && app.clientSecret === client_secret);
    }
    if (!apiClient) {
      const turnstile = await enforceTurnstilePolicy({
        secret: env.TURNSTILE_SECRET,
        token: turnstileToken,
        remoteIp,
        expectedHostname: new URL(getBaseUrl(env)).hostname,
        expectedAction: "login",
      });
      if (!turnstile.success) {
        return json({ error: "invalid_grant", error_description: "Security check failed. Please try again.", error_code: "turnstile_error" }, 401);
      }
    }

    const actor = await getActorByEmail(env.DB, username.toLowerCase());
    if (!actor || !actor.passwordHash) {
      return json({ error: "invalid_grant", error_description: "Invalid credentials", error_code: "login_error_invalid_credentials" }, 401);
    }

    const valid = await verifyPassword(password, actor.passwordHash);
    if (!valid) {
      // Per-account lockout: independent of IP, so rotating proxies can't
      // mount a credential-stuffing run against one account.
      const { allowed } = await checkRateLimit(env.KV, `login-fail:${await mediaCacheId(username.toLowerCase())}`, 10, 900);
      if (!allowed) {
        return json({ error: "invalid_grant", error_description: "Too many failed attempts. Please try again later.", error_code: "login_error_rate_limited" }, 429);
      }
      return json({ error: "invalid_grant", error_description: "Invalid credentials", error_code: "login_error_invalid_credentials" }, 401);
    }
    await env.KV.delete(`login-fail:${await mediaCacheId(username.toLowerCase())}`).catch(() => {});

    // Suspended accounts cannot sign in. Without this the web UI would appear
    // to log in and then fail every API call with a 401 (the API itself
    // rejects suspended tokens in getAuthenticatedActor).
    if (actor.suspended) {
      return json({
        error: "invalid_grant",
        error_description: "This account has been suspended.",
        error_code: "login_error_suspended",
      }, 403);
    }

    // Memorialized accounts are preserved in memoriam and cannot sign in
    // (Mastodon's `User#active_for_authentication?`).
    if (actor.memorial) {
      return json({
        error: "invalid_grant",
        error_description: "This account is in memoriam.",
        error_code: "login_error_memorial",
      }, 403);
    }

    // Block login for accounts that registered via the web form but haven't verified their email.
    if (!actor.emailVerified) {
      return json({
        error: "unverified_email",
        error_description: "Please verify your email address before signing in.",
        error_code: "login_error_unverified_email",
      }, 403);
    }

    // Approval-required instances keep the account unusable until an admin
    // approves it; surface that at login instead of issuing a dead token.
    if (actor.isLocal && actor.approved === false) {
      return json({
        error: "invalid_grant",
        error_description: "Your account is awaiting administrator approval.",
        error_code: "login_error_pending_approval",
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

    // App-level tokens have no user behind them (anonymous public reads): never
    // grant them write scope, whatever the app registered for.
    const scope = clampScope("read", app.scopes, "read");
    const accessToken = generateSecureToken();
    const now = Math.floor(Date.now() / 1000);

    await createOAuthToken(env.DB, {
      id: crypto.randomUUID(),
      appId: app.id,
      actorId: null,
      accessToken,
      refreshToken: null,
      scope,
      expiresAt: new Date((now + 3600) * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    return json({
      access_token: accessToken,
      token_type: "Bearer",
      scope,
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
      clientId?: string;
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
    // registered redirect_uri, so a leaked code alone is useless. (Codes minted
    // before `clientId` was stored simply skip the check; they live 10 min.)
    if (client_id && payload.clientId && client_id !== payload.clientId) {
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

    // Scopes are clamped to the app that actually owns the code: the payload
    // stores our internal row id, so look the app up by its client_id.
    const codeApp = await getOAuthAppByClientId(env.DB, payload.clientId ?? "");
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

  if (grantType === "refresh_token") {
    const { refresh_token, client_id, client_secret } = body;
    if (!refresh_token) {
      return json({ error: "invalid_request", error_description: "refresh_token is required" }, 400);
    }

    const row = await getOAuthTokenByRefreshToken(env.DB, refresh_token);
    // App-level tokens (client_credentials) never carry a refresh token; a row
    // without an actor cannot be refreshed into a user session.
    if (!row || !row.actorId) {
      return json({ error: "invalid_grant", error_description: "Invalid refresh token" }, 400);
    }

    // When the client identifies itself it must be the app the token was issued
    // to, and a supplied secret must match. Public clients may refresh with just
    // the refresh token (it is the credential).
    if (client_id || client_secret) {
      const app = row.appId ? await getOAuthAppById(env.DB, row.appId) : null;
      if (!app || (client_id && client_id !== app.clientId) || (client_secret && app.clientSecret !== client_secret)) {
        return json({ error: "invalid_client", error_description: "Invalid client credentials" }, 401);
      }
    }

    // The account must still be usable: refreshing must not resurrect a
    // suspended, unconfirmed or pending-approval session (same gates as
    // getAuthenticatedActor).
    const actor = await getActorById(env.DB, row.actorId);
    if (!actor || actor.suspended || (actor.isLocal && (!actor.emailVerified || actor.approved === false))) {
      return json({ error: "invalid_grant", error_description: "This account cannot refresh its session" }, 400);
    }

    // Rotate the access token in place: the refresh token and the granted scope
    // stay the same (Mastodon/Doorkeeper), the old access token dies here.
    const accessToken = generateSecureToken();
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600 * 24 * 30;
    await refreshOAuthTokenAccessToken(env.DB, row.id, accessToken, new Date((now + expiresIn) * 1000).toISOString());

    return json({
      access_token: accessToken,
      token_type: "Bearer",
      scope: row.scope,
      created_at: now,
      refresh_token,
    });
  }

  return json({ error: "unsupported_grant_type" }, 400);
}