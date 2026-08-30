import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getActorById, getLastStatusAt } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { PAGE_SIZE, MAX_COLLECTION_PAGE } from "@/lib/constants";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0");
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(PAGE_SIZE)), MAX_COLLECTION_PAGE);
  const localOnly = request.nextUrl.searchParams.get("local") === "true";
  const order = request.nextUrl.searchParams.get("order") ?? "active";

  const orderClause = order === "new" ? "created_at DESC" : "statuses_count DESC";

  let query = "SELECT id FROM actors WHERE discoverable = 1 AND is_local = 1";
  const params: unknown[] = [];
  if (localOnly) {
    query += " AND domain = ?";
    params.push(domain);
  }
  query += ` ORDER BY ${orderClause} LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await env.DB.prepare(query).bind(...params).all<{ id: string }>();

  const accounts = await Promise.all(
    rows.results.map(async (r) => {
      const a = await getActorById(env.DB, r.id);
      if (!a) return null;
      const lastStatusAt = await getLastStatusAt(env.DB, a.id);
      return serializeAccount(a, domain, { lastStatusAt });
    })
  );

  return json(accounts.filter(Boolean));
}