import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const { id } = await params;
  const actor = await getActorById(env.DB, id);
  if (!actor) return notFound();

  // Mark email as verified as a proxy for approval
  await env.DB.prepare("UPDATE actors SET email_verified = 1, updated_at = datetime('now') WHERE id = ?").bind(id).run();

  const updated = await getActorById(env.DB, id);
  return json({
    id: updated!.id,
    account: serializeAccount(updated!, domain),
  });
}
