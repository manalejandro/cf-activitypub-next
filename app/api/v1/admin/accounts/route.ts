import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { rowToActor } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { requireAdmin } from "@/lib/admin-auth";
import { PAGE_SIZE, MAX_COLLECTION_PAGE } from "@/lib/constants";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(PAGE_SIZE)), MAX_COLLECTION_PAGE);
  const page = parseInt(request.nextUrl.searchParams.get("page") ?? "1");
  const offset = (page - 1) * limit;
  const status = request.nextUrl.searchParams.get("status") ?? "all";
  const role = request.nextUrl.searchParams.get("role") ?? "all";
  const local = request.nextUrl.searchParams.get("local") ?? "false";
  const remote = request.nextUrl.searchParams.get("remote") ?? "false";
  const q = request.nextUrl.searchParams.get("q") ?? "";

  let sql = "SELECT * FROM actors WHERE 1=1";
  const binds: unknown[] = [];

  if (local === "true") {
    sql += " AND is_local = 1";
  } else if (remote === "true") {
    sql += " AND is_local = 0";
  }

  if (status === "active") {
    sql += " AND email_verified = 1";
  } else if (status === "pending") {
    sql += " AND email_verified = 0";
  } else if (status === "suspended") {
    sql += " AND suspended = 1";
  } else if (status === "silenced") {
    sql += " AND silenced = 1";
  }

  if (role !== "all") {
    sql += " AND role = ?";
    binds.push(role);
  }

  if (q) {
    sql += " AND (username LIKE ? OR display_name LIKE ?)";
    binds.push(`%${q}%`, `%${q}%`);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  binds.push(limit, offset);

  let rows: Record<string, unknown>[] = [];
  let totalCount = 0;
  try {
    const result = await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();
    rows = result.results;
    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM actors WHERE 1=1" +
      (local === "true" ? " AND is_local = 1" : remote === "true" ? " AND is_local = 0" : "") +
      (status !== "all" ? (status === "active" ? " AND email_verified = 1" : status === "pending" ? " AND email_verified = 0" : status === "suspended" ? " AND suspended = 1" : " AND silenced = 1") : "") +
      (role !== "all" ? " AND role = ?" : "") +
      (q ? " AND (username LIKE ? OR display_name LIKE ?)" : "")
    ).bind(...(role !== "all" ? [role] : []), ...(q ? [`%${q}%`, `%${q}%`] : [])).first<{ count: number }>();
    totalCount = totalRow?.count ?? 0;
  } catch {
    // Missing columns (role, suspended) — run migration: npx wrangler d1 execute cf-ap --remote --file=lib/db/migrations/007-admin-columns.sql
  }

  const accounts = rows.map((r) => {
    const actor = rowToActor(r);
    return {
      id: actor.id,
      username: actor.username,
      domain: actor.domain,
      created_at: actor.createdAt,
      email: actor.email,
      last_active_at: r.last_active_at ? String(r.last_active_at) : null,
      role: String(r.role ?? "user"),
      confirmed: actor.emailVerified,
      suspended: Boolean(r.suspended),
      silenced: Boolean(r.silenced),
      approved: true,
      account: serializeAccount(actor, domain),
    };
  });

  return json({ accounts, total: totalCount });
}

export async function POST(): Promise<Response> {
  return json({ error: "Not implemented" }, 501);
}
