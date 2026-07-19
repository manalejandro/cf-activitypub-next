import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getActorById, rowToActor } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "40"), 80);
  const page = parseInt(request.nextUrl.searchParams.get("page") ?? "1");
  const offset = (page - 1) * limit;
  const status = request.nextUrl.searchParams.get("status") ?? "all";
  const role = request.nextUrl.searchParams.get("role") ?? "all";
  const q = request.nextUrl.searchParams.get("q") ?? "";

  let sql = "SELECT * FROM actors WHERE 1=1";
  const binds: unknown[] = [];

  if (status === "active") {
    sql += " AND suspended = 0 AND email_verified = 1";
  } else if (status === "pending") {
    sql += " AND email_verified = 0";
  } else if (status === "suspended") {
    sql += " AND suspended = 1";
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

  const rows = await env.DB.prepare(sql).bind(...binds).all();

  const total = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM actors WHERE 1=1" +
    (status !== "all" ? (status === "active" ? " AND suspended = 0 AND email_verified = 1" : status === "pending" ? " AND email_verified = 0" : " AND suspended = 1") : "") +
    (role !== "all" ? " AND role = ?" : "") +
    (q ? " AND (username LIKE ? OR display_name LIKE ?)" : "")
  ).bind(...(role !== "all" ? [role] : []), ...(q ? [`%${q}%`, `%${q}%`] : [])).first<{ count: number }>();

  const accounts = rows.results.map((r: any) => {
    const actor = rowToActor(r as any);
    return {
      id: actor.id,
      username: actor.username,
      domain: actor.domain,
      created_at: actor.createdAt,
      email: actor.email,
      role: r.role ?? "user",
      confirmed: actor.emailVerified,
      suspended: Boolean(r.suspended),
      approved: true,
      account: serializeAccount(actor, domain),
    };
  });

  return json({ accounts, total: total?.count ?? 0 });
}

export async function POST(request: NextRequest): Promise<Response> {
  return json({ error: "Not implemented" }, 501);
}
