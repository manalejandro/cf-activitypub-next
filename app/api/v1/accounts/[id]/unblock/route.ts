import { type NextRequest } from "next/server";
import { json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, deleteBlock } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { buildRelationship } from "@/lib/mastodon/relationships";
import { env } from "cloudflare:workers";

// POST /api/v1/accounts/:id/unblock
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const target = await getActorById(env.DB, decodeURIComponent(id));
  if (!target) return notFound("Account not found");

  await deleteBlock(env.DB, actor.id, target.id);

  return json(await buildRelationship(env.DB, actor.id, target.id));
}
