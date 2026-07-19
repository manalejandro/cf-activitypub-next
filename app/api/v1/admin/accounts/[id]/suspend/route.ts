import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  await env.DB.prepare("UPDATE actors SET suspended = 1, updated_at = datetime('now') WHERE id = ?").bind(id).run();

  return json({ id, suspended: true });
}
