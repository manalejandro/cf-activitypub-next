import { type NextRequest } from "next/server";
import { getBaseUrl } from "@/lib/cf";
import { atomicRateLimit } from "@/lib/rate-limit";
import { getActorByEmail, getOAuthAppByClientId, mediaCacheId, updatePassword } from "@/lib/db";
import { verifyPassword, generateSecureToken, hashPassword, needsPasswordRehash } from "@/lib/auth";
import { enforceTurnstilePolicy } from "@/lib/turnstile";
import { env } from "cloudflare:workers";

// POST /api/oauth/authorize — processes the authorize form submission
export async function POST(request: NextRequest): Promise<Response> {
  const origin = new URL(request.url).origin;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
  const client_id = form.get("client_id") as string;
  const redirect_uri = form.get("redirect_uri") as string;
  const scope = (form.get("scope") as string) ?? "read";
  const state = (form.get("state") as string) ?? "";
  const code_challenge = (form.get("code_challenge") as string) ?? null;
  const code_challenge_method = (form.get("code_challenge_method") as string) ?? null;
  const action = form.get("action") as string;
  const email = form.get("email") as string;
  const password = form.get("password") as string;


  // Validate app
  const app = await getOAuthAppByClientId(env.DB, client_id);
  if (!app) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Invalid client");
  }

  // Validate redirect_uri against registered URIs (prevents open redirect)
  const registeredUris = app.redirectUri.split(/[\n,]/).map((u) => u.trim());
  if (!registeredUris.includes(redirect_uri)) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Invalid redirect URI");
  }

  // Handle deny (after validation so redirect_uri is safe)
  if (action === "deny") {
    const dest = buildRedirect(redirect_uri, null, "access_denied", state);
    return Response.redirect(dest, 302);
  }

  // Throttle credential checks: this form verifies passwords and has no captcha.
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { allowed } = await atomicRateLimit(env, `authorize:${clientIp}`, 20, 60);
  if (!allowed) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Too many attempts, please try again later");
  }

  // Captcha (parity with the web login and the password grant): this is a
  // second credential-checking surface, so when the instance configures
  // Turnstile the consent form must carry a solved challenge. The policy skips
  // only when no secret is set, and a missing token never counts as verified.
  const turnstile = await enforceTurnstilePolicy({
    secret: env.TURNSTILE_SECRET,
    token: (form.get("cf-turnstile-response") as string | null) ?? "",
    remoteIp: clientIp,
    expectedHostname: new URL(getBaseUrl(env)).hostname,
    expectedAction: "login",
  });
  if (!turnstile.success) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Security check failed. Please try again.");
  }

  // Authenticate user
  const actor = await getActorByEmail(env.DB, email?.toLowerCase());
  if (!actor || !actor.passwordHash) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Invalid credentials");
  }

  // Per-account lockout, shared with the /oauth/token password grant (same
  // key) and checked BEFORE verifying: failures across both credential
  // surfaces count together, and rotating proxies cannot mount a
  // credential-stuffing (or PBKDF2-burning) run against one account. A
  // success clears the counter.
  const lockoutKey = `login-fail:${await mediaCacheId(email?.toLowerCase() ?? "")}`;
  const lockout = await atomicRateLimit(env, lockoutKey, 10, 900);
  if (!lockout.allowed) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Too many failed attempts. Please try again later");
  }

  const valid = await verifyPassword(password, actor.passwordHash);
  if (!valid) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Invalid credentials");
  }
  await env.KV.delete(lockoutKey).catch(() => {});

  // Transparent rehash of legacy-cost password hashes (same as the password
  // grant): best effort, a failed write only defers it to the next login.
  if (needsPasswordRehash(actor.passwordHash)) {
    try {
      await updatePassword(env.DB, actor.id, await hashPassword(password));
    } catch { /* keep the legacy hash for now */ }
  }

  // Suspended accounts cannot sign in (the API would reject every call with a
  // token anyway); memorialized accounts are preserved in memoriam and cannot
  // sign in either — same gates as the password grant.
  if (actor.suspended) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "This account has been suspended.");
  }
  if (actor.memorial) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "This account is memorialized and cannot sign in.");
  }

  if (!actor.emailVerified) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Email not verified");
  }

  // Approval-required instances: pending accounts can't obtain a token.
  if (actor.approved === false) {
    return redirectToAuthorize(origin, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Your account is pending approval");
  }

  // Generate auth code, store in KV for 10 minutes
  const code = generateSecureToken();
  const payload = JSON.stringify({
    actorId: actor.id,
    appId: app.id,
    // The token exchange compares the *client_id* the app sends (OAuth requires
    // it); `appId` is our internal row id and must never be compared to it.
    clientId: app.clientId,
    scope,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
  });
  await env.KV.put(`oauth_code:${code}`, payload, { expirationTtl: 600 });

  // Redirect back to the app
  if (redirect_uri === "urn:ietf:wg:oauth:2.0:oob") {
    return new Response(
      `<html><body style="font-family:sans-serif;max-width:400px;margin:60px auto;padding:20px">
        <h2>Authorization code</h2>
        <p>Copy this code and paste it into the application:</p>
        <pre style="background:#f5f5f5;padding:12px;border-radius:4px;word-break:break-all">${code}</pre>
      </body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const dest = buildRedirect(redirect_uri, code, null, state);
  return Response.redirect(dest, 302);
}

function buildRedirect(redirectUri: string, code: string | null, error: string | null, state: string): string {
  const url = new URL(redirectUri);
  if (code) url.searchParams.set("code", code);
  if (error) url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

function redirectToAuthorize(
  origin: string,
  clientId: string,
  redirectUri: string,
  scope: string,
  state: string,
  codeChallenge: string | null,
  codeChallengeMethod: string | null,
  error: string
): Response {
  const url = new URL("/oauth/authorize", origin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("error", error);
  if (codeChallenge) url.searchParams.set("code_challenge", codeChallenge);
  if (codeChallengeMethod) url.searchParams.set("code_challenge_method", codeChallengeMethod);
  return Response.redirect(url.toString(), 302);
}
