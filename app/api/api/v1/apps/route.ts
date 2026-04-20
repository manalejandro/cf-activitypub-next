import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { createOAuthApp } from "@/lib/db";

// POST /api/v1/apps — Register a new OAuth application
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  let body: Record<string, string>;
  const contentType = request.headers.get("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    body = await request.json();
  } else {
    const form = await request.formData();
    body = Object.fromEntries(
      [...form.entries()].map(([k, v]) => [k, String(v)])
    );
  }

  const { client_name, redirect_uris, scopes = "read", website } = body;

  if (!client_name || !redirect_uris) {
    return json({ error: "client_name and redirect_uris are required" }, 422);
  }

  const id = generateId();
  const clientId = generateSecureToken();
  const clientSecret = generateSecureToken();

  await createOAuthApp(env.DB, {
    id,
    name: client_name,
    website: website ?? null,
    redirectUri: redirect_uris,
    scopes,
    clientId,
    clientSecret,
    createdAt: new Date().toISOString(),
  });

  return json({
    id,
    name: client_name,
    website: website ?? null,
    redirect_uri: redirect_uris,
    client_id: clientId,
    client_secret: clientSecret,
    vapid_key: "",
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
