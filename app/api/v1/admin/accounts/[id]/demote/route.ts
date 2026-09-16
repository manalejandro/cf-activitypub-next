import { type NextRequest } from "next/server";
import type { D1Database } from "@cloudflare/workers-types";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { requireFullAdmin } from "@/lib/admin-auth";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  if (!(await requireFullAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();
  if (actor.role === "admin" && (await wouldRemoveLastAdmin(env.DB, id))) {
    return json({ error: "Cannot demote the last administrator" }, 422);
  }

  try {
    await env.DB.prepare("UPDATE actors SET role = 'user', updated_at = datetime('now') WHERE id = ?").bind(id).run();
  } catch {
    return json({ error: "Missing role column — run migration: npx wrangler d1 execute cf-ap --remote --file=lib/db/migrations/007-admin-columns.sql" }, 500);
  }

  return json({ id, role: "user" });
}

/** Refuse to demote/delete the instance's last full administrator. */
async function wouldRemoveLastAdmin(db: D1Database, actorId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM actors WHERE is_local = 1 AND role = 'admin' AND id != ?")
    .bind(actorId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0) === 0;
}

