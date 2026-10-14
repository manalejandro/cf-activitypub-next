import { type NextRequest } from "next/server";
import { buildProfileFeed, renderRssFeed, FEED_PAGE_SIZE, FEED_PAGE_SIZE_MAX } from "@/lib/feeds";
import { env } from "cloudflare:workers";

/**
 * GET /users/:username/rss — the account's public posts as RSS 2.0 (Mastodon's
 * `/@username.rss`), with the attachments as Media RSS items and an enclosure
 * for the first audio file. `?limit=` (max 200) and `?max_id=` paginate.
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
    format: "rss",
    limit: Number.isFinite(requested) ? Math.min(Math.max(1, requested), FEED_PAGE_SIZE_MAX) : FEED_PAGE_SIZE,
    maxId: url.searchParams.get("max_id") ?? undefined,
  });
  if (!feed) return new Response("Not found", { status: 404 });

  return new Response(renderRssFeed(feed), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      // Mastodon: `expires_in 1.minute, public: true`.
      "Cache-Control": "public, max-age=60",
    },
  });
}
