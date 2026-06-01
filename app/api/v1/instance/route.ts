import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { serializeInstanceV2 } from "@/lib/mastodon/serializers";

// GET /api/v1/instance (legacy Mastodon v1)
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const userRow = await env.DB
    .prepare("SELECT COUNT(*) as count FROM actors WHERE is_local = 1")
    .first<{ count: number }>();

  const userCount = userRow?.count ?? 0;
  const title = env.INSTANCE_TITLE ?? domain;
  const description = env.INSTANCE_DESCRIPTION ?? "An ActivityPub server";
  const version = env.INSTANCE_VERSION ?? "0.1.0";

  const v2 = serializeInstanceV2(domain, title, description, version, userCount);

  // Map v2 structure to v1 shape
  return json({
    uri: domain,
    title,
    description,
    short_description: description,
    email: "",
    version: version,
    urls: { streaming_api: "" },
    stats: { user_count: userCount, status_count: 0, domain_count: 1 },
    languages: ["en"],
    contact_account: null,
    rules: [],
    registrations: true,
    approval_required: false,
    invites_enabled: false,
  });
}
