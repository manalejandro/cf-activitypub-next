import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl, json } from "@/lib/cf";
import { getActorByEmail, createActor, createOAuthToken, getOAuthAppByClientId, createEmailVerification } from "@/lib/db";
import { generateKeyPair } from "@/lib/activitypub/security";
import { actorIRI } from "@/lib/activitypub/utils";
import { hashPassword, generateSecureToken } from "@/lib/auth";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { sendVerificationEmail } from "@/lib/email";

// POST /api/v1/accounts — Register a new account
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  let body: Record<string, string>;
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    const form = await request.formData();
    body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  }

  const { username, email, password } = body;
  const turnstileToken = body["cf-turnstile-response"];

  if (!username || !email || !password) {
    return json({ error: "username, email and password are required" }, 422);
  }

  if (!/^[a-zA-Z0-9_]{1,30}$/.test(username)) {
    return json({ error: "Username must be 1-30 alphanumeric characters or underscores" }, 422);
  }

  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters" }, 422);
  }

  // If a Turnstile token is provided (web form), verify it.
  // API clients (Mastodon apps) that don't send a Turnstile token skip this check.
  const webRegistration = Boolean(turnstileToken);
  if (webRegistration) {
    const remoteIp = request.headers.get("CF-Connecting-IP") ?? undefined;
    const valid = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET, remoteIp);
    if (!valid) {
      return json({ error: "Security check failed. Please try again." }, 422);
    }
  }

  const existing = await getActorByEmail(env.DB, email);
  if (existing) {
    return json({ error: "Email already taken" }, 422);
  }

  const existingUsername = await env.DB
    .prepare("SELECT id FROM actors WHERE username = ? AND domain = ?")
    .bind(username.toLowerCase(), domain)
    .first();
  if (existingUsername) {
    return json({ error: "Username already taken" }, 422);
  }

  const { publicKeyPem, privateKeyPem } = await generateKeyPair();
  const passwordHash = await hashPassword(password);
  const actorId = actorIRI(baseUrl, username);

  // Web registrations require email verification; API registrations are auto-verified.
  const emailVerified = !webRegistration;

  await createActor(env.DB, {
    id: actorId,
    username: username.toLowerCase(),
    domain,
    displayName: username,
    summary: null,
    avatarUrl: null,
    headerUrl: null,
    publicKeyPem,
    privateKeyPem,
    isLocal: true,
    isBot: false,
    manuallyApprovesFollowers: false,
    discoverable: true,
    followersCount: 0,
    followingCount: 0,
    statusesCount: 0,
    email: email.toLowerCase(),
    passwordHash,
    emailVerified,
    autoDeleteAfter: null,
  });

  if (webRegistration) {
    // Send verification email; do not issue a token yet.
    const token = generateSecureToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await createEmailVerification(env.DB, actorId, token, expiresAt);

    const instanceBaseUrl = getBaseUrl(env);
    const verifyUrl = `${instanceBaseUrl}/api/auth/verify-email?token=${token}`;

    try {
      await sendVerificationEmail(env.EMAIL, {
        to: email.toLowerCase(),
        from: env.FROM_EMAIL,
        verifyUrl,
        instanceTitle: env.INSTANCE_TITLE,
      });
    } catch (err) {
      console.error("[register] Failed to send verification email:", err);
      // Continue — don't fail registration if email sending fails.
      // The user can request a resend from the login page.
    }

    return json({ pending_verification: true }, 200);
  }

  // API registration: auto-create access token (Mastodon clients expect it on registration)
  const { client_id } = body;
  const app = client_id ? await getOAuthAppByClientId(env.DB, client_id) : null;
  const accessToken = generateSecureToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 3600 * 24 * 30;

  await createOAuthToken(env.DB, {
    id: accessToken,
    appId: app?.id ?? null,
    actorId,
    accessToken,
    refreshToken: null,
    scope: body.scope ?? "read write follow push",
    expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  });

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    scope: body.scope ?? "read write follow push",
    created_at: now,
  }, 200);
}
