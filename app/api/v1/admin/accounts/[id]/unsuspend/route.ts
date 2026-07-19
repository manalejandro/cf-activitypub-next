import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  try {
    await env.DB.prepare("UPDATE actors SET suspended = 0, updated_at = datetime('now') WHERE id = ?").bind(id).run();
  } catch {
    return json({ error: "Missing suspended column — run migration: npx wrangler d1 execute cf-ap --remote --file=lib/db/migrations/007-admin-columns.sql" }, 500);
  }

  return json({ id, suspended: false });
}
