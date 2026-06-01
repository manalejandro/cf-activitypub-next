import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getFollow, isBlocked } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";

// GET /api/v1/accounts/relationships?id[]=xxx&id[]=yyy
// Used by Mastodon clients to display the follow/block/mute state for one or more accounts.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  // Mastodon sends either id[]=... (array) or id=... (single)
  const ids = [
    ...request.nextUrl.searchParams.getAll("id[]"),
    ...request.nextUrl.searchParams.getAll("id"),
  ].filter(Boolean);

  const relationships = await Promise.all(
    ids.map(async (id) => {
      const rawId = decodeURIComponent(id);
      const [outgoing, incoming] = await Promise.all([
        getFollow(env.DB, actor.id, rawId),
        getFollow(env.DB, rawId, actor.id),
      ]);

      const [blocking, blocked_by] = await Promise.all([
        isBlocked(env.DB, actor.id, rawId),
        isBlocked(env.DB, rawId, actor.id),
      ]);

      return {
        id: rawId,
        following: outgoing?.state === "accepted",
        showing_reblogs: outgoing?.state === "accepted",
        notifying: false,
        languages: null,
        followed_by: incoming?.state === "accepted",
        blocking,
        blocked_by,
        muting: false,
        muting_notifications: false,
        requested: outgoing?.state === "pending",
        requested_by: incoming?.state === "pending",
        domain_blocking: false,
        endorsed: false,
        note: "",
      };
    })
  );

  return json(relationships);
}
