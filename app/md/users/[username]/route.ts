import { type NextRequest } from "next/server";
import { notFound } from "@/lib/cf";
import { MARKDOWN_CONTENT_TYPE, accountMarkdownDocument } from "@/lib/markdown-agents";
import { encodeStatusId } from "@/lib/mastodon/statusId";
import { getActorByUsername, getActorFields, getActorStatuses } from "@/lib/db";
import { isoTimestamp } from "@/lib/activitypub/utils";
import { env } from "cloudflare:workers";

// GET /md/users/:username — a local profile and its recent public posts as
// markdown. `proxy.ts` rewrites `/users/:username` (and `/@username`) here when
// the client prefers `text/markdown`.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { username } = await params;
  const domain = new URL(request.url).hostname;
  const baseUrl = new URL(request.url).origin;

  const actor = await getActorByUsername(env.DB, decodeURIComponent(username), domain);
  // Only local accounts (like the profile feeds), and a suspended one serves
  // nothing.
  if (!actor || !actor.isLocal || actor.suspended) return notFound("Actor not found");

  const [fields, statuses] = await Promise.all([
    getActorFields(env.DB, actor.id),
    // Same selection as the RSS/Atom feed: public + unlisted, no replies and no
    // boosts, newest first.
    getActorStatuses(env.DB, actor.id, 10, undefined, undefined, false, { includeBoosts: false }),
  ]);

  const body = accountMarkdownDocument({
    acct: actor.isLocal ? actor.username : `${actor.username}@${actor.domain}`,
    displayName: actor.displayName || actor.username,
    url: `${baseUrl}/@${actor.username}`,
    apId: actor.id,
    note: actor.summary,
    fields: fields.map((field) => ({ name: field.name, value: field.value })),
    counts: {
      followers: actor.followersCount,
      following: actor.followingCount,
      statuses: actor.statusesCount,
    },
    createdAt: isoTimestamp(actor.createdAt),
    posts: statuses.map(({ object }) => ({
      url: `${baseUrl}/statuses/${encodeURIComponent(encodeStatusId(object.id, object.local))}`,
      published: isoTimestamp(object.published),
      content: object.content,
      contentWarning: object.contentWarning,
    })),
  });

  return new Response(body, {
    headers: {
      "Content-Type": MARKDOWN_CONTENT_TYPE,
      "Cache-Control": "public, max-age=300",
      Vary: "Accept",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
