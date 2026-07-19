import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  const rows = await env.DB
    .prepare(
      `SELECT a.* FROM actors a
       WHERE a.is_local = 1
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(
      Math.min(parseInt(request.nextUrl.searchParams.get("limit") ?? "20"), 40),
      parseInt(request.nextUrl.searchParams.get("offset") ?? "0")
    )
    .all<Record<string, unknown>>();
  const { serializeAccount } = await import("@/lib/mastodon/serializers");
  const domain = new URL(request.url).hostname;
  return json(rows.results.map((r) => serializeAccount({
    id: r.id as string,
    username: r.username as string,
    domain: r.domain as string,
    displayName: (r.display_name as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    avatarUrl: (r.avatar_url as string | null) ?? null,
    headerUrl: (r.header_url as string | null) ?? null,
    publicKeyPem: r.public_key_pem as string,
    privateKeyPem: (r.private_key_pem as string | null) ?? null,
    isLocal: Boolean(r.is_local),
    isBot: Boolean(r.is_bot),
    manuallyApprovesFollowers: Boolean(r.manually_approves_followers),
    discoverable: Boolean(r.discoverable),
    followersCount: Number(r.followers_count ?? 0),
    followingCount: Number(r.following_count ?? 0),
    statusesCount: Number(r.statuses_count ?? 0),
    email: (r.email as string | null) ?? null,
    passwordHash: (r.password_hash as string | null) ?? null,
    emailVerified: Boolean(r.email_verified),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    inbox: (r.inbox as string | undefined),
    autoDeleteAfter: (r.auto_delete_after as number | null) ?? null,
  }, domain)));
}
