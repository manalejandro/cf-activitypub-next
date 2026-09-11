import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, undismissSuggestedAccount } from "@/lib/db";

// DELETE /api/v1/suggestions/:account_id — undo a previous dismissal so the
// account can be suggested again. Idempotent.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ account_id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { account_id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const target = await getActorById(env.DB, decodeURIComponent(account_id));
  if (!target) return notFound("Account not found");

  await undismissSuggestedAccount(env.DB, actor.id, target.id);
  return json({});
}
