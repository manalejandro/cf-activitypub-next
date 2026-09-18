import { type NextRequest } from "next/server";
import { getCloudflareContext, getBaseUrl, json, checkRateLimit } from "@/lib/cf";
import {
  getActorByEmail,
  getActorByCanonicalEmailHash,
  createCanonicalEmailBlock,
  getCanonicalEmailBlock,
  createActor,
  createOAuthToken,
  getOAuthAppByClientId,
  createEmailVerification,
  getRegistrationSettings,
} from "@/lib/db";
import { generateKeyPair } from "@/lib/activitypub/security";
import { actorIRI, generateId } from "@/lib/activitypub/utils";
import { hashPassword, generateSecureToken } from "@/lib/auth";
import { enforceTurnstilePolicy } from "@/lib/turnstile";
import { sendVerificationEmail } from "@/lib/email";
import { evaluateRegistration } from "@/lib/moderation/ai";
import { rejectAccount, approveAccount, GUARDIAN_MODEL } from "@/lib/moderation/actions";
import { runWithTimeout } from "@/lib/moderation/util";
import { chargeGlobalAI, AI_UNITS_REASON } from "@/lib/moderation/budget";
import { computeRegistrationSignals } from "@/lib/moderation/heuristics";
import { canonicalEmailHash } from "@/lib/canonical-email";
import { recordModeration } from "@/lib/moderation/log";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { clampScope } from "@/lib/oauth-scopes";

// POST /api/v1/accounts — Register a new account
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  // Canonical instance URL: local actor ids must never be derived from the
  // request Host (workers.dev alias / host-header poisoning would create
  // actors whose id/inbox point at a foreign host).
  const baseUrl = getBaseUrl(env);
  const domain = new URL(baseUrl).hostname;

  let body: Record<string, string> = {};
  const contentType = request.headers.get("Content-Type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      body = await request.json();
    } else {
      const form = await request.formData();
      body = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    }
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const { username, email, password } = body;
  const turnstileToken = body["cf-turnstile-response"];

  // Registration policy from instance settings (Mastodon-compatible:
  // registrations.enabled / approval_required / reason_required / min_age).
  const regs = await getRegistrationSettings(env.DB);
  if (!regs.enabled) {
    return json({ error: "Registrations are not open on this server", error_code: "register_closed" }, 422);
  }
  if (regs.reasonRequired && !(body.reason ?? "").trim()) {
    return json({ error: "A registration reason is required", error_code: "register_error_reason_required" }, 422);
  }
  if (regs.minAge && body.age_confirmed !== "true") {
    return json({ error: `You must be at least ${regs.minAge} years old to register`, error_code: "register_age_required" }, 422);
  }

  // Rate limit: 5 registration attempts per IP per 60s window
  const remoteIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { allowed, remaining } = await checkRateLimit(env.KV, `register:${remoteIp}`, 5, 60);
  if (!allowed) {
    return json({ error: "Too many registration attempts. Please try again later.", error_code: "register_error_rate_limited" }, 429);
  }

  if (!username || !email || !password) {
    return json({ error: "username, email and password are required", error_code: "register_error_fields_required" }, 422);
  }

  if (!/^[a-zA-Z0-9_]{1,30}$/.test(username)) {
    return json({ error: "Username must be 1-30 alphanumeric characters or underscores", error_code: "register_error_username_invalid" }, 422);
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, error_code: "register_error_password_short" }, 422);
  }

  // Account creation is a browser-only flow (Mastodon apps authenticate
  // existing accounts, they don't register them), so the captcha is mandatory
  // whenever the instance has one configured. Trusting a token only when the
  // client bothered to send it was a trivial bypass: omitting
  // `cf-turnstile-response` skipped the check entirely.
  const turnstile = await enforceTurnstilePolicy({
    secret: env.TURNSTILE_SECRET,
    token: turnstileToken,
    remoteIp: request.headers.get("CF-Connecting-IP") ?? undefined,
    expectedHostname: new URL(getBaseUrl(env)).hostname,
    expectedAction: "register",
  });
  if (!turnstile.success) {
    return json({ error: "Security check failed. Please try again.", error_code: "turnstile_error" }, 422);
  }
  // A verified captcha means the web flow: the account must confirm its email
  // before the API token is usable (never auto-verified).
  const webRegistration = !turnstile.skipped;

  const existing = await getActorByEmail(env.DB, email);
  if (existing) {
    return json({ error: "Email already taken", error_code: "register_error_email_taken" }, 422);
  }

  // ── Canonical mailbox checks (anti-abuse) ────────────────────────────────
  // `user+tag@domain` and dotted variants of one mailbox must not mint a farm
  // of accounts: the mailbox is identified by sha256(canonical address),
  // blocked mailboxes are rejected, and a mailbox that already registered (or
  // keeps trying) is blocked and audited.
  const canonHash = await canonicalEmailHash(email);
  const attemptsKey = `canonical:reg:${canonHash}`;
  let priorAttempts = 0;
  try {
    priorAttempts = Number((await env.KV.get(attemptsKey)) ?? 0) || 0;
  } catch { /* KV hiccup must not break registration */ }

  const canonicalBlock = await getCanonicalEmailBlock(env.DB, canonHash);
  const canonicalOwner = canonHash ? await getActorByCanonicalEmailHash(env.DB, canonHash) : null;
  const farmAttempt = priorAttempts >= 2;

  if (canonicalBlock || canonicalOwner || farmAttempt) {
    if (!canonicalBlock) {
      await createCanonicalEmailBlock(
        env.DB,
        canonHash,
        email.toLowerCase(),
        canonicalOwner
          ? `Duplicate canonical email of @${canonicalOwner.username} (registration farm)`
          : "Repeated registrations from the same mailbox"
      ).catch(() => {});
    }
    await recordModeration(env, {
      id: generateId(),
      source: "heuristic",
      targetType: "email",
      targetId: canonHash.slice(0, 12),
      action: "registration_blocked",
      reason: canonicalOwner
        ? `Canonical email already registered as @${canonicalOwner.username}.`
        : "Registration attempts from a blocked or abused mailbox.",
      confidence: "high",
      model: "heuristic",
      details: { existing: canonicalOwner?.username ?? null, attempts: priorAttempts + 1 },
      emailSent: false,
      emailTo: null,
      relatedId: null,
    });
    return json({ error: "Email already taken", error_code: "register_error_email_taken" }, 422);
  }

  try {
    await env.KV.put(attemptsKey, String(priorAttempts + 1), { expirationTtl: 86400 });
  } catch { /* best-effort */ }

  const existingUsername = await env.DB
    .prepare("SELECT id FROM actors WHERE username = ? AND domain = ?")
    .bind(username.toLowerCase(), domain)
    .first();
  if (existingUsername) {
    return json({ error: "Username already taken", error_code: "register_error_username_taken" }, 422);
  }

  const { publicKeyPem, privateKeyPem } = await generateKeyPair();
  const passwordHash = await hashPassword(password);
  const actorId = actorIRI(baseUrl, username);

  // Every self-service registration must confirm its email. A missing Turnstile
  // token means "API client" (apps can't solve a captcha), never "skip
  // verification" — that was letting bots create verified accounts.
  const emailVerified = false;

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
    canonicalEmailHash: canonHash,
    passwordHash,
    emailVerified,
    autoDeleteAfter: null,
  });

  // ── Guardian: screen the new account profile ──────────────────────────────
  // The LLM is a last resort. A registration is only reviewed by the reasoning
  // model when deterministic signals flag it (suspicious IP, disposable email,
  // spammy username). Clean registrations are approved without spending AI
  // neurons; the scheduled moderation cycle can revisit any account later.
  const registrationSignals = computeRegistrationSignals({
    username: username.toLowerCase(),
    email: email.toLowerCase(),
    ipSuspicious: remaining <= 2,
    canonicalVariant: priorAttempts > 0,
  });

  if (registrationSignals.flags.length > 0 && env.AI && (await chargeGlobalAI(env, AI_UNITS_REASON))) {
    const review = await runWithTimeout(
      evaluateRegistration(env, {
        username: username.toLowerCase(),
        displayName: username,
        summary: "",
        source: webRegistration ? "web" : "api",
        ipSuspicious: remaining <= 2,
      }),
      4000,
      null
    );

    if (review?.action === "reject") {
      await rejectAccount(env, {
        actorId,
        reason: review.reason,
        confidence: review.confidence,
        source: "ai",
        model: GUARDIAN_MODEL,
        details: { stage: "registration", username: username.toLowerCase(), source: webRegistration ? "web" : "api", flags: registrationSignals.flags },
      });
      return json({ error: "Registration not approved: your account does not meet the community guidelines.", error_code: "register_error_not_approved" }, 422);
    }

    if (review?.action === "approve" && review.confidence === "high") {
      await approveAccount(env, {
        actorId,
        reason: review.reason,
        confidence: review.confidence,
        source: "ai",
        model: GUARDIAN_MODEL,
        details: { stage: "registration", username: username.toLowerCase(), flags: registrationSignals.flags },
      });
    }
  }

  // Registration policy: accounts stay pending admin approval when the
  // instance requires it; the sign-up reason is stored for the admin view.
  if (regs.approvalRequired || regs.reasonRequired) {
    await env.DB
      .prepare("UPDATE actors SET approved = ?, registration_reason = ? WHERE id = ?")
      .bind(regs.approvalRequired ? 0 : 1, regs.reasonRequired ? (body.reason ?? "").trim() : null, actorId)
      .run();
  }

  // Always send the confirmation email: web forms and third-party apps alike.
  {
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
  }

  if (webRegistration) {
    // The web form waits for the user to open the link (and, when the instance
    // requires it, for an admin to approve the account).
    return json(
      regs.approvalRequired
        ? { pending_verification: true, pending_approval: true }
        : { pending_verification: true },
      200
    );
  }
  if (regs.approvalRequired) {
    // Approval-required instances don't issue tokens at registration time;
    // the account can log in once an admin approves it.
    return json({ pending_approval: true }, 200);
  }
  // API registration: issue the access token like Mastodon does. It stays
  // unusable until the address is confirmed (getAuthenticatedActor rejects
  // unverified accounts), so clients must wait for the user to click the link.
  const { client_id } = body;
  const app = client_id ? await getOAuthAppByClientId(env.DB, client_id) : null;
  const accessToken = generateSecureToken();
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 3600 * 24 * 30;

  await createOAuthToken(env.DB, {
    id: crypto.randomUUID(),
    appId: app?.id ?? null,
    actorId,
    accessToken,
    refreshToken: null,
    scope: clampScope(body.scope, app?.scopes, "read write follow push"),
    expiresAt: new Date((now + expiresIn) * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  });

  return json({
    access_token: accessToken,
    token_type: "Bearer",
    scope: clampScope(body.scope, app?.scopes, "read write follow push"),
    created_at: now,
  }, 200);
}
