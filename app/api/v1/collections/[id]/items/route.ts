import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getCollectionById, addAccountToCollection } from "@/lib/db";

// POST /api/v1/collections/:collection_id/items — add an account to a Collection.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const col = await getCollectionById(env.DB, id);
  if (!col) return notFound("Collection not found");
  if (col.account_id !== actor.id) return json({ error: "This action is not allowed" }, 403);

  let accountId = "";
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json() as { account_id?: string };
    accountId = body.account_id ?? "";
  } else {
    const form = await request.formData();
    accountId = (form.get("account_id") as string) ?? "";
  }
  if (!accountId) return badRequest("`account_id` parameter is missing");

  const item = await addAccountToCollection(env.DB, id, accountId);
  if (!item) return badRequest("Could not add the given account");

  return json({
    collection_item: {
      id: item.id,
      account_id: item.accountId,
      state: item.state,
      created_at: item.createdAt,
    },
  });
}
