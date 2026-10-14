import { type NextRequest } from "next/server";
import { buildProfileFeed, renderAtomFeed, FEED_PAGE_SIZE, FEED_PAGE_SIZE_MAX } from "@/lib/feeds";
import { env } from "cloudflare:workers";

/**
 * GET /users/:username/atom — the same profile feed as Atom 1.0
 * (`/@username.atom`), for readers that prefer it over RSS.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ username: string }> }
): Promise<Response> {
  const { username } = await params;
  const url = new URL(request.url);
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);

  const feed = await buildProfileFeed(env, {
    username,
    host: url.hostname,
    format: "atom",
    limit: Number.isFinite(requested) ? Math.min(Math.max(1, requested), FEED_PAGE_SIZE_MAX) : FEED_PAGE_SIZE,
    maxId: url.searchParams.get("max_id") ?? undefined,
  });
  if (!feed) return new Response("Not found", { status: 404 });

  return new Response(renderAtomFeed(feed), {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
