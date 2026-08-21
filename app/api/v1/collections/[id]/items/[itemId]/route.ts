import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getCollectionById, getCollectionItemById, deleteCollectionItem } from "@/lib/db";

// DELETE /api/v1/collections/:collection_id/items/:item_id — remove an account
// from a Collection (owner only).
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id, itemId } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const col = await getCollectionById(env.DB, id);
  if (!col) return notFound("Collection not found");
  if (col.account_id !== actor.id) return json({ error: "This action is not allowed" }, 403);

  const item = await getCollectionItemById(env.DB, itemId);
  if (!item || item.collectionId !== id) return notFound("Collection item not found");

  await deleteCollectionItem(env.DB, itemId);

  return json({});
}
