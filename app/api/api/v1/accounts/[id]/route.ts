import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound } from "@/lib/cf";
import { getActorById, getActorStatuses, getFollow } from "@/lib/db";
import { serializeAccount, serializeStatus } from "@/lib/mastodon/serializers";
import { getAuthenticatedActor } from "@/lib/auth";

// GET /api/v1/accounts/:id
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const actor = await getActorById(env.DB, decodeURIComponent(id));
  if (!actor) return notFound("Account not found");

  return json(serializeAccount(actor, domain));
}
