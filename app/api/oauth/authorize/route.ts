import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@/lib/cf";
import { getActorByEmail, getOAuthAppByClientId } from "@/lib/db";
import { verifyPassword, generateSecureToken } from "@/lib/auth";

// POST /api/oauth/authorize — processes the authorize form submission
export async function POST(request: NextRequest): Promise<Response> {
  const form = await request.formData();
  const client_id = form.get("client_id") as string;
  const redirect_uri = form.get("redirect_uri") as string;
  const scope = (form.get("scope") as string) ?? "read";
  const state = (form.get("state") as string) ?? "";
  const code_challenge = (form.get("code_challenge") as string) ?? null;
  const code_challenge_method = (form.get("code_challenge_method") as string) ?? null;
  const action = form.get("action") as string;
  const email = form.get("email") as string;
  const password = form.get("password") as string;

  const { env } = getCloudflareContext();

  // Validate app
  const app = await getOAuthAppByClientId(env.DB, client_id);
  if (!app) {
    return redirectToAuthorize(client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Invalid client");
  }

  // Validate redirect_uri against registered URIs (prevents open redirect)
  const registeredUris = app.redirectUri.split(/[\n,]/).map((u) => u.trim());
  if (!registeredUris.includes(redirect_uri)) {
    return redirectToAuthorize(client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Invalid redirect URI");
  }

  // Handle deny (after validation so redirect_uri is safe)
  if (action === "deny") {
    const dest = buildRedirect(redirect_uri, null, "access_denied", state);
    return Response.redirect(dest, 302);
  }

  // Authenticate user
  const actor = await getActorByEmail(env.DB, email?.toLowerCase());
  if (!actor || !actor.passwordHash) {
    return redirectToAuthorize(client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Invalid credentials");
  }

  const valid = await verifyPassword(password, actor.passwordHash);
  if (!valid) {
    return redirectToAuthorize(client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Invalid credentials");
  }

  if (!actor.emailVerified) {
    return redirectToAuthorize(client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, "Email not verified");
  }

  // Generate auth code, store in KV for 10 minutes
  const code = generateSecureToken();
  const payload = JSON.stringify({
    actorId: actor.id,
    appId: app.id,
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
  clientId: string,
  redirectUri: string,
  scope: string,
  state: string,
  codeChallenge: string | null,
  codeChallengeMethod: string | null,
  error: string
): Response {
  const url = new URL("/oauth/authorize", "https://placeholder");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("error", error);
  if (codeChallenge) url.searchParams.set("code_challenge", codeChallenge);
  if (codeChallengeMethod) url.searchParams.set("code_challenge_method", codeChallengeMethod);
  return Response.redirect(`/oauth/authorize${url.search}`, 302);
}
