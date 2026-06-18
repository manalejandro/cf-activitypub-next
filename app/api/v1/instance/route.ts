import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";

// GET /api/v1/instance (legacy Mastodon v1)
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;

  const [userRow, postRow] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as count FROM actors WHERE is_local = 1").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) as count FROM objects WHERE is_local = 1").first<{ count: number }>(),
  ]);

  const userCount = userRow?.count ?? 0;
  const statusCount = postRow?.count ?? 0;
  const title = env.INSTANCE_TITLE ?? domain;
  const description = env.INSTANCE_DESCRIPTION ?? "An ActivityPub server";
  const version = env.INSTANCE_VERSION ?? "0.1.0";

  return json({
    uri: domain,
    title,
    description,
    short_description: description,
    email: `admin@${domain}`,
    version: `${version} (compatible; Mastodon 4.3.0)`,
    urls: { streaming_api: `wss://${domain}` },
    stats: { user_count: userCount, status_count: statusCount, domain_count: 1 },
    thumbnail: `https://${domain}/logo.svg`,
    languages: ["en"],
    contact_account: null,
    rules: [],
    registrations: true,
    approval_required: false,
    invites_enabled: false,
    configuration: {
      statuses: {
        max_characters: 500,
        max_media_attachments: 4,
        characters_reserved_per_url: 23,
      },
      media_attachments: {
        supported_mime_types: ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "audio/mpeg"],
        image_size_limit: 16 * 1024 * 1024,
        image_matrix_limit: 33_177_600,
        video_size_limit: 103_809_024,
        video_frame_rate_limit: 120,
        video_matrix_limit: 2_304_000,
      },
      polls: {
        max_options: 4,
        max_characters_per_option: 50,
        min_expiration: 300,
        max_expiration: 2_629_746,
      },
    },
  });
}
