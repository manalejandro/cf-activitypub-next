import { type NextRequest } from "next/server";
import { getCloudflareContext } from "@/lib/cf";
import { getInstanceContactActor, getInstanceSetting, getInstanceStats, getRegistrationSettings } from "@/lib/db";
import { serializeAccount } from "@/lib/mastodon/serializers";
import { SUPPORTED_MEDIA_MIME_TYPES, MASTODON_COMPAT_VERSION, INSTANCE_LANGUAGES, resolveLimits } from "@/lib/constants";

// GET /api/v1/instance (legacy Mastodon v1)
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const limits = resolveLimits(env as unknown as Record<string, unknown>);

  // Every client fetches instance info on startup; a burst of logins would run
  // these count queries against D1 per request. Cache the serialized payload.
  const cacheKey = "instance:v1";
  const cached = await env.KV.get(cacheKey).catch(() => null);
  if (cached) {
    return new Response(cached, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  const [contactActor, rulesRaw, languagesRaw, stats, regs] = await Promise.all([
    getInstanceContactActor(env.DB),
    getInstanceSetting(env.DB, "rules"),
    getInstanceSetting(env.DB, "languages"),
    getInstanceStats(env.DB, env.KV),
    getRegistrationSettings(env.DB),
  ]);

  const userCount = stats.userCount;
  const statusCount = stats.statusCount;
  const title = env.INSTANCE_TITLE ?? domain;
  const description = env.INSTANCE_DESCRIPTION ?? "An ActivityPub server";
  const appVersion = env.INSTANCE_VERSION ?? "0.1.0";

  let rules: { id: string; text: string }[] = [];
  try { rules = rulesRaw ? JSON.parse(rulesRaw) : []; } catch { /* ignore */ }
  let languages: string[] = INSTANCE_LANGUAGES;
  try {
    const langs = languagesRaw ? JSON.parse(languagesRaw) as { code: string }[] : [];
    if (langs.length > 0) languages = langs.map((l) => l.code);
  } catch { /* ignore */ }

  const payload = {
    uri: domain,
    title,
    description,
    short_description: description,
    email: `admin@${domain}`,
    version: `${appVersion} (compatible; Mastodon ${MASTODON_COMPAT_VERSION})`,
    urls: { streaming_api: `wss://${domain}/api/v1/streaming` },
    stats: { user_count: userCount, status_count: statusCount, domain_count: 1 },
    thumbnail: `https://${domain}/logo.svg`,
    languages,
    contact_account: contactActor ? serializeAccount(contactActor, domain) : null,
    vapid_public_key: env.VAPID_PUBLIC_KEY ?? null,
    rules,
    registrations: regs.enabled,
    approval_required: regs.approvalRequired,
    invites_enabled: false,
    configuration: {
      accounts: {
        max_featured_tags: limits.maxFeaturedTags,
        max_pinned_statuses: limits.maxPinnedStatuses,
        max_display_name_length: limits.maxDisplayNameChars,
        max_note_length: limits.maxNoteChars,
        max_profile_fields: limits.maxProfileFields,
        profile_field_name_limit: limits.maxProfileFieldChars,
        profile_field_value_limit: limits.maxProfileFieldChars,
      },
      statuses: {
        max_characters: limits.maxStatusChars,
        max_media_attachments: limits.maxMediaAttachments,
        characters_reserved_per_url: limits.charactersReservedPerUrl,
      },
      media_attachments: {
        supported_mime_types: SUPPORTED_MEDIA_MIME_TYPES,
        description_limit: limits.maxAltTextChars,
        image_size_limit: limits.maxImageSize,
        image_matrix_limit: limits.imageMatrixLimit,
        video_size_limit: limits.maxVideoSize,
        video_frame_rate_limit: limits.videoFrameRateLimit,
        video_matrix_limit: limits.videoMatrixLimit,
      },
      polls: {
        max_options: limits.maxPollOptions,
        max_characters_per_option: limits.maxPollOptionChars,
        min_expiration: limits.pollMinExpiration,
        max_expiration: limits.pollMaxExpiration,
      },
      calls: { enabled: true },
    },
    limits,
  };

  const body = JSON.stringify(payload);
  await env.KV.put(cacheKey, body, { expirationTtl: 900 }).catch(() => {});
  return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
