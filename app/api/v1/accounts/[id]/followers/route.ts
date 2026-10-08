import { type NextRequest } from "next/server";
import { json, notFound } from "@/lib/cf";
import { getActorById, getFollowers, getLastStatusAtMap, getAllCustomEmojis } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";
import { env } from "cloudflare:workers";

// GET /api/v1/accounts/:id/followers
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const { id } = await params;
  const domain = new URL(request.url).hostname;
  const rawId = decodeURIComponent(id);

  const actor = await getActorById(env.DB, rawId);
  if (!actor) return notFound("Account not found");

  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.pageSize));
  const page = parseInt(request.nextUrl.searchParams.get("page") ?? "0");
  const followers = await getFollowers(env.DB, actor.id, Math.min(limit, limits.maxPageSize), page * limit);

  // The bio (note) must render custom emojis, so the serializer needs the
  // emoji catalogue — same as the account route passes it. The last-status
  // dates are batched instead of one query per account.
  const [allEmojis, lastStatusAtMap] = await Promise.all([
    getAllCustomEmojis(env.DB),
    getLastStatusAtMap(env.DB, followers.map((f) => f.id)),
  ]);
  const result = followers.map((f) =>
    serializeAccount(f, domain, {
      lastStatusAt: lastStatusAtMap.get(f.id) ?? null,
      emojis: allEmojis,
    })
  );
  return json(result);
}
