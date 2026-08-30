import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, notFound } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getObjectById, getActorById, getAttachmentsByObjectId, getAllCustomEmojis, getObjectQuotesCount, getObjectsQuoting } from "@/lib/db";
import { serializeStatus } from "@/lib/mastodon/serializers";
import { serializeQuote } from "@/lib/mastodon/quote";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import { DEFAULT_TIMELINE_PAGE, MAX_PAGE_SIZE } from "@/lib/constants";

// GET /api/v1/statuses/:id/quotes — statuses quoting this one (auth required).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const domain = new URL(request.url).hostname;

  const authActor = await getAuthenticatedActor(request, env.DB);
  if (!authActor) return unauthorized();

  const obj = await getObjectById(env.DB, decodeStatusId(id, domain));
  if (!obj) return notFound("Status not found");

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? String(DEFAULT_TIMELINE_PAGE)), MAX_PAGE_SIZE);
  const maxIdRaw = request.nextUrl.searchParams.get("max_id") ?? undefined;
  const maxId = maxIdRaw ? decodeStatusId(maxIdRaw, domain) : undefined;

  const objects = await getObjectsQuoting(env.DB, obj.id, authActor.id, limit, maxId);
  const allEmojis = await getAllCustomEmojis(env.DB);

  const statuses = await Promise.all(
    objects.map(async (o) => {
      const author = await getActorById(env.DB, o.actorId);
      if (!author) return null;
      const [attachments, quotesCount, quote] = await Promise.all([
        getAttachmentsByObjectId(env.DB, o.id),
        getObjectQuotesCount(env.DB, o.id),
        o.quoteId
          ? getObjectById(env.DB, o.quoteId).then((q) => serializeQuote(env.DB, q, domain))
          : Promise.resolve(null),
      ]);
      return serializeStatus(o, author, domain, {
        attachments,
        favourited: false,
        reblogged: false,
        emojis: allEmojis,
        quote,
        quotesCount,
      });
    })
  );

  return json(statuses.filter(Boolean));
}