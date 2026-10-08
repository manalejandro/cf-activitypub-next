import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getTagSuggestions } from "@/lib/db";
import { env } from "cloudflare:workers";

export async function GET(request: NextRequest): Promise<Response> {

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const suggestions = await getTagSuggestions(env.DB, actor.id);
  return json(suggestions);
}