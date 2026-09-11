import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getAccountSuggestions, getAllCustomEmojis } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { resolveLimits } from "@/lib/constants";

// GET /api/v2/suggestions — recommended accounts (Mastodon-compatible shape:
// `[{ source, account }]`). Optional auth: anonymous visitors get active local
// accounts; authenticated users get friends-of-friends first, minus the
// accounts they follow, block, mute or dismissed.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const limits = resolveLimits(env as unknown as Record<string, unknown>);
  const domain = new URL(request.url).hostname;

  const me = await getAuthenticatedActor(request, env.DB);
  const limit = Math.min(
    Math.max(parseInt(request.nextUrl.searchParams.get("limit") ?? String(limits.defaultTimelinePage)), 1),
    limits.maxPageSize
  );
  const offset = Math.max(parseInt(request.nextUrl.searchParams.get("offset") ?? "0"), 0);

  const [suggestions, emojis] = await Promise.all([
    getAccountSuggestions(env.DB, me?.id ?? null, { limit, offset }),
    getAllCustomEmojis(env.DB),
  ]);

  return json(
    suggestions.map(({ actor, source }) => ({
      source,
      account: serializeAccount(actor, domain, { emojis }),
    }))
  );
}
