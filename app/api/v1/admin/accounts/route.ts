import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "40"), 80);
  const offset = parseInt(request.nextUrl.searchParams.get("page") ?? "1");

  const rows = await env.DB
    .prepare("SELECT id FROM actors ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .bind(limit, (offset - 1) * limit)
    .all<{ id: string }>();

  const accounts = await Promise.all(
    rows.results.map(async (r) => {
      const a = await getActorById(env.DB, r.id);
      return a ? serializeAccount(a, domain) : null;
    })
  );

  return json(accounts.filter(Boolean));
}

export async function POST(request: NextRequest): Promise<Response> {
  // Admin account creation is not implemented
  return json({ error: "Not implemented" }, 501);
}
