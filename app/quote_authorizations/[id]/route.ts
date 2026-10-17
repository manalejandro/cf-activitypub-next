import { type NextRequest } from "next/server";
import { activityJson, getBaseUrl, notFound } from "@/lib/cf";
import { getActorById, getObjectById, getQuoteAuthorizationById } from "@/lib/db";
import { buildQuoteAuthorization } from "@/lib/activitypub/quotes";
import { env } from "cloudflare:workers";

/**
 * GET /quote_authorizations/:id — the FEP-044f `QuoteAuthorization` we issued
 * for one of our posts.
 *
 * Mastodon fetches this before rendering a quote of ours (`ActivityPub::
 * VerifyQuoteService`): it must be a `QuoteAuthorization` whose
 * `interactingObject` is the quoting status and whose `interactionTarget` is
 * our post, or the quote stays as "pending approval". The id is built from the
 * canonical instance URL, never the request Host.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const row = await getQuoteAuthorizationById(env.DB, id);
  if (!row) return notFound("Quote authorization not found");

  const object = await getObjectById(env.DB, row.objectId);
  const author = object ? await getActorById(env.DB, object.actorId) : null;
  if (!object || !author) return notFound("Quote authorization not found");

  const baseUrl = getBaseUrl(env);
  return activityJson(buildQuoteAuthorization(baseUrl, row, author.id));
}
