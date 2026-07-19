import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getOAuthAppByClientId } from "@/lib/db";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return unauthorized();
  const tokenRow = await env.DB
    .prepare("SELECT app_id FROM oauth_tokens WHERE access_token = ?")
    .first<{ app_id: string }>(token);
  if (!tokenRow?.app_id) return json({ name: "API", website: null, vapid_key: null, client_id: null }, 200);
  const app = await getOAuthAppByClientId(env.DB, tokenRow.app_id);
  if (!app) return json({ name: "API", website: null, vapid_key: null, client_id: null }, 200);
  return json({
    name: app.name,
    website: app.website ?? null,
    vapid_key: null,
    client_id: app.clientId,
  });
}
