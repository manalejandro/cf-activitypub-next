import { type NextRequest } from "next/server";
import { getCloudflareContext, activityJson, notFound } from "@/lib/cf";
import { getActorByUsername, getActorStatuses } from "@/lib/db";
import { buildActor, buildNote, buildCreate, buildOrderedCollection, buildOrderedCollectionPage, objectIRI, actorIRI } from "@/lib/activitypub/utils";

// GET /users/:username/outbox
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getActorByUsername(env.DB, username, domain);
  if (!actor || !actor.isLocal) return notFound("Actor not found");

  const outboxId = `${actorIRI(baseUrl, username)}/outbox`;
  const page = request.nextUrl.searchParams.get("page");

  if (!page) {
    return activityJson(buildOrderedCollection(outboxId, actor.statusesCount));
  }

  const maxId = page !== "true" ? page : undefined;
  const statuses = await getActorStatuses(env.DB, actor.id, 20, maxId);

  const items = statuses
    .filter((s) => s.visibility === "public")
    .map((s) => {
      const note = buildNote(baseUrl, s.id, {
        actorUsername: username,
        content: s.content ?? "",
        published: s.published,
        visibility: s.visibility as "public" | "unlisted" | "followers" | "direct",
        inReplyTo: s.inReplyToId ?? undefined,
        sensitive: s.sensitive,
        summary: s.contentWarning ?? undefined,
        language: s.language ?? undefined,
      });
      return buildCreate(baseUrl, actorIRI(baseUrl, username), note, s.id + "-create");
    });

  const nextId =
    items.length === 20
      ? `${outboxId}?page=${statuses[statuses.length - 1]?.id}`
      : undefined;

  return activityJson(buildOrderedCollectionPage(outboxId, items, nextId));
}
