import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getActorByEmail, createActor, createOAuthToken, getOAuthAppByClientId } from "@/lib/db";
import { generateKeyPair } from "@/lib/activitypub/security";
import { actorIRI } from "@/lib/activitypub/utils";
import { hashPassword, generateSecureToken } from "@/lib/auth";

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

  if (!username || !email || !password) {
    return json({ error: "username, email and password are required" }, 422);
  }

  if (!/^[a-zA-Z0-9_]{1,30}$/.test(username)) {
    return json({ error: "Username must be 1-30 alphanumeric characters or underscores" }, 422);
  }

  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters" }, 422);
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
    autoDeleteAfter: null,
  });

  const actor = await env.DB
    .prepare("SELECT * FROM actors WHERE id = ?")
    .bind(actorId)
    .first();

  // Auto-create access token (Mastodon clients expect it on registration)
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
