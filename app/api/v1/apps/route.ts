import { type NextRequest } from "next/server";
import { formDataToBody } from "@/lib/request-body";
import { json, checkRateLimit } from "@/lib/cf";
import { createOAuthApp } from "@/lib/db";
import { env } from "cloudflare:workers";

// POST /api/v1/apps — Register a new OAuth application
export async function POST(request: NextRequest): Promise<Response> {
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // Mastodon clients register one app per installation; the tighter window
  // keeps crawlers from filling the table while normal onboarding still fits.
  const { allowed } = await checkRateLimit(env.KV, `apps:${clientIp}`, 5, 1800);
  if (!allowed) {
    return json({ error: "Too many requests. Please try again later." }, 429);
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
