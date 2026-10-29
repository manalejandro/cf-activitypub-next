import { type NextRequest } from "next/server";
import { formDataToBody } from "@/lib/request-body";
import { json } from "@/lib/cf";
import { atomicRateLimit } from "@/lib/rate-limit";
import { createOAuthApp } from "@/lib/db";
import { env } from "cloudflare:workers";

const APPS_RATE_MAX = 10;
const APPS_RATE_WINDOW = 600;

// POST /api/v1/apps — Register a new OAuth application
export async function POST(request: NextRequest): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // Mastodon clients register one app per installation AND retry the
  // registration on every failed login attempt, often from a shared egress IP
  // (CGNAT, home Wi-Fi): a 5-per-30-min window locked out real users (Tusky
  // bounced to its first screen on a 429). 10 per 10 minutes still bounds
  // crawler table growth — and the prune trigger plus the cron sweep already
  // clean unused apps — while a lockout now heals in minutes, not half an hour.
  const { allowed, retryAfter } = await atomicRateLimit(env, `apps:${clientIp}`, APPS_RATE_MAX, APPS_RATE_WINDOW);
  if (!allowed) {
    // The DO reports the window rollover; the KV fallback does not, so derive
    // it from the same fixed-window math checkRateLimit uses.
    const retrySeconds = retryAfter && retryAfter > 0
      ? Math.ceil(retryAfter)
      : APPS_RATE_WINDOW - (Math.floor(Date.now() / 1000) % APPS_RATE_WINDOW);
    return json(
      { error: "Too many requests. Please try again later." },
      429,
      { "Retry-After": String(Math.max(1, retrySeconds)) }
    );
  }

  let body: Record<string, unknown>;
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    const form = await request.formData();
    body = formDataToBody(form);
  }

  const clientName = String(body.client_name ?? "").trim();
  const redirectUris = String(body.redirect_uris ?? "").trim();
  const scopes = String(body.scopes ?? "read");
  const website = body.website === undefined || body.website === null || body.website === "" ? null : String(body.website);

  if (!clientName || !redirectUris) {
    return json({ error: "client_name and redirect_uris are required" }, 422);
  }

  const id = generateId();
  const clientId = generateSecureToken();
  const clientSecret = generateSecureToken();

  await createOAuthApp(env.DB, {
    id,
    name: clientName,
    website,
    redirectUri: redirectUris,
    scopes,
    clientId,
    clientSecret,
    createdAt: new Date().toISOString(),
  });

  return json({
    id,
    name: clientName,
    website,
    redirect_uri: redirectUris,
    client_id: clientId,
    client_secret: clientSecret,
    vapid_key: env.VAPID_PUBLIC_KEY ?? "",
  });
}

// Helper re-export
function generateId() {
  return crypto.randomUUID();
}

function generateSecureToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
