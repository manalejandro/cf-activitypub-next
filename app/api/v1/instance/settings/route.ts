import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { getAllCustomEmojis, getInstanceSetting } from "@/lib/db";
import { processStatusContent } from "@/lib/activitypub/content";
import { resolveMentionLinks } from "@/lib/activitypub/mentions";
import { env } from "cloudflare:workers";

// GET /api/v1/instance/settings — public instance content that the admin has
// configured. Only returns the settings that are actually set, rendered to
// HTML (links, mentions, hashtags and custom emoji) via processStatusContent.
export async function GET(request: NextRequest): Promise<Response> {
  const baseUrl = `https://${new URL(request.url).hostname}`;
  const emojis = await getAllCustomEmojis(env.DB);

  const [rulesRaw, extended, privacy, tos] = await Promise.all([
    getInstanceSetting(env.DB, "rules"),
    getInstanceSetting(env.DB, "extended_description"),
    getInstanceSetting(env.DB, "privacy_policy"),
    getInstanceSetting(env.DB, "terms_of_service"),
  ]);

  // Only handles that resolve to a real account become links (`@algo` stays
  // plain text), same as statuses.
  const render = async (text: string): Promise<string> =>
    processStatusContent(text, baseUrl, emojis, {
      mentions: await resolveMentionLinks(env.DB, text, baseUrl, env.KV),
    }).html;

  const out: Record<string, unknown> = {};
  if (rulesRaw) {
    try {
      const rules = JSON.parse(rulesRaw) as { id: string; text: string }[];
      if (Array.isArray(rules) && rules.length > 0) {
        out.rules = await Promise.all(rules.map(async (r) => ({ id: r.id, text: r.text, html: await render(r.text) })));
      }
    } catch { /* ignore malformed */ }
  }
  if (extended && extended.trim()) out.extended_description = await render(extended);
  if (privacy && privacy.trim()) out.privacy_policy = await render(privacy);
  if (tos && tos.trim()) out.terms_of_service = await render(tos);
  return json(out);
}