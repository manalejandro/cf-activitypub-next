import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, dismissSuggestedAccount } from "@/lib/db";

// POST /api/v1/suggestions/:account_id/dismiss — hide an account from the
// viewer's suggestions. Idempotent.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ account_id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { account_id } = await params;

  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();

  const target = await getActorById(env.DB, decodeURIComponent(account_id));
  if (!target) return notFound("Account not found");

  await dismissSuggestedAccount(env.DB, me.id, target.id);
  return json({});
}
