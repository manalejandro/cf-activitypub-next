import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getConversationById, deleteConversation } from "@/lib/db";

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const conv = await getConversationById(env.DB, id);
  if (!conv) return notFound();
  if (conv.actor_id !== actor.id) return notFound();

  await deleteConversation(env.DB, id);
  return json({});
}
