import { type NextRequest } from "next/server";
import { json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { dismissNotification } from "@/lib/db";
import { env } from "cloudflare:workers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  const actor = await getAuthenticatedActor(_request, env.DB);
  if (!actor) return unauthorized();

  const dismissed = await dismissNotification(env.DB, id, actor.id);
  if (!dismissed) return notFound();

  return json({});
}
