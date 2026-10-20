import { type NextRequest } from "next/server";
import { notFound } from "@/lib/cf";
import { MARKDOWN_CONTENT_TYPE, statusMarkdownDocument } from "@/lib/markdown-agents";
import { decodeStatusId } from "@/lib/mastodon/statusId";
import {
  canViewStatus,
  getActorById,
  getAttachmentsByObjectIds,
  getObjectById,
  isAcceptedFollower,
} from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { loadSerializedPolls } from "@/lib/mastodon/serializers";
import { isoTimestamp } from "@/lib/activitypub/utils";
import { env } from "cloudflare:workers";

interface CardSnapshot {
  url?: string;
  title?: string | null;
  description?: string | null;
}

// GET /md/statuses/:id — the status permalink as markdown. `proxy.ts` rewrites
// a page request here when the client prefers `text/markdown` (the HTML page is
// a client-rendered shell, so converting it would return nothing).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const objectId = decodeStatusId(decodeURIComponent(id), domain);

  const obj = await getObjectById(env.DB, objectId);
  if (!obj) return notFound("Status not found");

  const viewer = await getAuthenticatedActor(request, env.DB).catch(() => null);
  const following = viewer ? await isAcceptedFollower(env.DB, viewer.id, obj.actorId) : false;
  if (!canViewStatus(obj, viewer?.id ?? null, following)) return notFound("Status not found");

  const author = await getActorById(env.DB, obj.actorId);
  // A suspended author's content is not served (the permalink is a 404 too).
  if (!author || author.suspended) return notFound("Status not found");

  const [attachments, polls] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, [obj.id]),
    loadSerializedPolls(env.DB, viewer?.id ?? null, [obj.id]),
  ]);
  const poll = polls.get(obj.id) ?? null;

  let card: CardSnapshot | null = null;
  if (obj.cardJson) {
    try {
      card = JSON.parse(obj.cardJson) as CardSnapshot;
    } catch {
      card = null;
    }
  }

  const baseUrl = new URL(request.url).origin;
  const body = statusMarkdownDocument({
    url: `${baseUrl}/statuses/${encodeURIComponent(id)}`,
    apId: obj.id,
    author: {
      acct: author.isLocal ? author.username : `${author.username}@${author.domain}`,
      displayName: author.displayName || author.username,
      url: `${baseUrl}/@${author.username}`,
    },
    published: isoTimestamp(obj.published),
    visibility: obj.visibility,
    content: obj.content,
    contentWarning: obj.contentWarning,
    attachments: (attachments.get(obj.id) ?? []).map((a) => ({
      type: a.type,
      url: a.url,
      description: a.description,
    })),
    poll: poll
      ? {
          options: (poll.options ?? []).map((option) => ({ title: option.title, votes: option.votes_count ?? 0 })),
          votesCount: poll.votes_count ?? 0,
        }
      : null,
    card: card?.url ? { url: card.url, title: card.title, description: card.description } : null,
    counts: { replies: obj.repliesCount, reblogs: obj.reblogsCount, favourites: obj.favouritesCount },
  });

  const publiclyCacheable = obj.visibility === "public" || obj.visibility === "unlisted";
  return new Response(body, {
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
      // A followers-only status is served to its audience but must never land
      // in a shared cache.
      "Cache-Control": publiclyCacheable ? "public, max-age=300" : "private, max-age=60",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
