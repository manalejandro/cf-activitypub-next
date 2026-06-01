import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getActorById, deleteBlock } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";

// POST /api/v1/accounts/:id/unblock
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const target = await getActorById(env.DB, decodeURIComponent(id));
  if (!target) return notFound("Account not found");

  await deleteBlock(env.DB, actor.id, target.id);

  return json({ id: target.id, blocking: false });
}
