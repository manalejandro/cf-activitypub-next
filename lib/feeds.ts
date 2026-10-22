/**
 * Profile feeds (RSS 2.0 / Atom 1.0), mirroring Mastodon's
 * `AccountsController#show` RSS branch (`app/views/accounts/show.rss.ruby`):
 * the account's public statuses (public + unlisted, no replies, no boosts),
 * newest first, with the CW preroll, the rendered content, the poll options,
 * the hashtags as categories and the attachments as Media RSS items (plus an
 * enclosure for the first audio file, Mastodon's podcast support).
 *
 * Only **local** accounts have feeds (Mastodon's route constraint excludes
 * remote handles) and a suspended account has none: its content is not served.
 */

import type { D1Database } from "@cloudflare/workers-types";
import {
  getAllCustomEmojis,
  getActorByUsername,
  getActorFeedStatuses,
  getAttachmentsByObjectIds,
  getInstanceSetting,
} from "@/lib/db";
import { serializeStatus, loadSerializedPolls } from "@/lib/mastodon/serializers";
import { DOCUMENT_MIME_TYPES } from "@/lib/constants";
import { encodeStatusId } from "@/lib/mastodon/statusId";
import type { LocalAttachment } from "@/lib/types";
import en from "@/lib/locales/en.json";
import es from "@/lib/locales/es.json";
import de from "@/lib/locales/de.json";
import fr from "@/lib/locales/fr.json";
import it from "@/lib/locales/it.json";
import ja from "@/lib/locales/ja.json";
import ko from "@/lib/locales/ko.json";
import pt from "@/lib/locales/pt.json";
import ru from "@/lib/locales/ru.json";
import zhHans from "@/lib/locales/zh-Hans.json";

/** Mastodon's `PAGE_SIZE` / `PAGE_SIZE_MAX` for the account RSS feed. */
export const FEED_PAGE_SIZE = 20;
export const FEED_PAGE_SIZE_MAX = 200;

const DICTS: Record<string, Record<string, string>> = {
  en,
  es,
  de,
  fr,
  it,
  ja,
  ko,
  pt,
  ru,
  "zh-hans": zhHans as unknown as Record<string, string>,
};

export interface FeedAttachment {
  url: string;
  mimeType: string;
  size: number | null;
  type: string;
  description: string | null;
  /** True for audio/video/gifv: Mastodon's enclosure candidates. */
  audio: boolean;
}

export interface FeedEntry {
  id: string;
  url: string;
  published: string;
  /** HTML: CW preroll + content + poll options. */
  html: string;
  /** Plain text (Atom's required title). */
  title: string;
  tags: string[];
  attachments: FeedAttachment[];
}

export interface ProfileFeed {
  title: string;
  description: string;
  link: string;
  selfLink: string;
  icon: string | null;
  generator: string;
  language: string;
  lastBuild: string | null;
  entries: FeedEntry[];
}

export interface FeedEnv {
  DB: D1Database;
  INSTANCE_TITLE?: string;
  INSTANCE_VERSION?: string;
}

/** The instance's primary language, used for the feed's description. */
async function feedLanguage(db: D1Database): Promise<string> {
  try {
    const raw = await getInstanceSetting(db, "languages");
    const parsed = raw ? (JSON.parse(raw) as { code?: string }[]) : [];
    const code = parsed.find((l) => l?.code)?.code;
    if (code && DICTS[code.toLowerCase()]) return code;
  } catch { /* fall back to English */ }
  return "en";
}

function feedDescription(language: string, acct: string): string {
  const dict = DICTS[language.toLowerCase()] ?? DICTS.en;
  const template = dict.rss_feed_description ?? DICTS.en.rss_feed_description ?? "Public posts from @{acct}";
  return template.replace("{acct}", acct);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toIso(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return `${value.replace(" ", "T")}Z`;
  return value;
}

/** Plain text for Atom's required entry title (tags stripped, entities decoded). */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Custom emoji render as inline images; feed readers have no site stylesheet,
 * so size them like Mastodon's `SYNDICATED_EMOJI_STYLES` (`height: 1.1em`).
 */
function syndicatedEmojiStyles(html: string): string {
  return html.replace(
    /<img([^>]*class="emojione custom-emoji"[^>]*)>/g,
    (match, attrs: string) =>
      /style=/.test(attrs)
        ? match
        : `<img${attrs} style="height: 1.1em; margin: -.2ex .15em .2ex; object-fit: contain; vertical-align: middle; width: 1.1em;">`
  );
}

function attachmentKind(att: LocalAttachment): string {
  const mime = att.mimeType ?? "";
  if (att.type === "audio" || mime.startsWith("audio/")) return "audio";
  if (att.type === "video" || mime.startsWith("video/")) return "video";
  // Documents are a Media RSS medium of their own ("document"); calling a PDF an
  // image made readers try to render it as one.
  if (att.type === "unknown" || DOCUMENT_MIME_TYPES.includes(mime)) return "document";
  return "image";
}

/** Absolute URL for a stored (possibly relative or cached) attachment URL. */
function absoluteUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * The renderer emits site-relative links (`/tags/x`, `/@user`); a feed reader
 * resolves them against the feed URL and a syndicated copy loses them, so make
 * them absolute like Mastodon's renderer does.
 */
function absolutizeLinks(html: string, base: string): string {
  return html.replace(/\s(href|src)="(\/[^"]*)"/g, (_match, attr: string, path: string) => ` ${attr}="${base}${path}"`);
}

export async function buildProfileFeed(
  env: FeedEnv,
  opts: { username: string; host: string; format: "rss" | "atom"; limit?: number; maxId?: string }
): Promise<ProfileFeed | null> {
  const { username, host } = opts;
  const base = `https://${host}`;

  const actor = await getActorByUsername(env.DB, username, host);
  // Feeds are for local accounts whose content is served (Mastodon's RSS route
  // only matches local usernames; a suspended account's content is gone).
  if (!actor || !actor.isLocal || actor.suspended) return null;

  const limit = Math.min(Math.max(1, opts.limit ?? FEED_PAGE_SIZE), FEED_PAGE_SIZE_MAX);
  const objects = await getActorFeedStatuses(env.DB, actor.id, limit, opts.maxId);
  const language = await feedLanguage(env.DB);

  const [attachmentMap, pollMap, emojis] = await Promise.all([
    getAttachmentsByObjectIds(env.DB, objects.map((o) => o.id)),
    loadSerializedPolls(env.DB, null, objects.map((o) => o.id)),
    getAllCustomEmojis(env.DB),
  ]);

  const entries: FeedEntry[] = [];
  for (const obj of objects) {
    const attachments = attachmentMap.get(obj.id) ?? [];
    const status = serializeStatus(obj, actor, host, {
      attachments,
      poll: pollMap.get(obj.id) ?? null,
      emojis,
    });

    const content = absolutizeLinks(syndicatedEmojiStyles(status.content ?? ""), base);
    const preroll = status.spoiler_text
      ? `<p><strong>${escapeXml(status.spoiler_text)}</strong></p><hr>`
      : "";
    // Poll options as disabled inputs, like Mastodon's `rss_content_postroll`.
    const postroll = status.poll
      ? `<p>${status.poll.options
          .map(
            (option) =>
              `<input type="${status.poll?.multiple ? "checkbox" : "radio"}" disabled> ${escapeXml(option.title)}`
          )
          .join("<br>")}</p>`
      : "";

    const permalink = `${base}/@${actor.username}/${encodeStatusId(obj.id, obj.local)}`;
    entries.push({
      id: permalink,
      url: permalink,
      published: status.created_at,
      html: `${preroll}${content}${postroll}`,
      title: plainText(status.spoiler_text ? `${status.spoiler_text} — ${status.content ?? ""}` : status.content ?? "").slice(0, 140),
      tags: (status.tags ?? []).map((tag) => tag.name),
      attachments: attachments.map((att) => ({
        url: absoluteUrl(att.url, base),
        mimeType: att.mimeType ?? "application/octet-stream",
        size: att.fileSize ?? null,
        type: attachmentKind(att),
        description: att.description ?? null,
        audio: attachmentKind(att) === "audio",
      })),
    });
  }

  return {
    title: actor.displayName || actor.username,
    description: feedDescription(language, actor.domain && actor.domain !== host ? `${actor.username}@${actor.domain}` : `${actor.username}@${host}`),
    link: `${base}/@${actor.username}`,
    selfLink: `${base}/users/${actor.username}/${opts.format}`,
    icon: actor.avatarCacheUrl ? absoluteUrl(actor.avatarCacheUrl, base) : actor.avatarUrl ? absoluteUrl(actor.avatarUrl, base) : null,
    generator: `${env.INSTANCE_TITLE ?? "CF ActivityPub"} v${env.INSTANCE_VERSION ?? ""}`.trim(),
    language,
    lastBuild: entries[0]?.published ?? null,
    entries,
  };
}

/** RSS 2.0 + Media RSS, like Mastodon's `show.rss.ruby`. */
export function renderRssFeed(feed: ProfileFeed): string {
  const items = feed.entries
    .map((entry) => {
      const enclosure = entry.attachments.find((att) => att.audio);
      const media = entry.attachments
        .map(
          (att) =>
            `      <media:content url="${escapeXml(att.url)}" type="${escapeXml(att.mimeType)}"${
              att.size ? ` fileSize="${att.size}"` : ""
            } medium="${att.type}">\n` +
            `        <media:rating scheme="urn:simple">nonadult</media:rating>\n` +
            (att.description ? `        <media:description>${escapeXml(att.description)}</media:description>\n` : "") +
            `      </media:content>`
        )
        .join("\n");
      return `    <item>
      <link>${escapeXml(entry.url)}</link>
      <guid isPermaLink="true">${escapeXml(entry.id)}</guid>
      <pubDate>${new Date(entry.published).toUTCString()}</pubDate>
      <description>${escapeXml(entry.html)}</description>${
        enclosure ? `\n      <enclosure url="${escapeXml(enclosure.url)}" type="${escapeXml(enclosure.mimeType)}"${enclosure.size ? ` length="${enclosure.size}"` : ""}/>` : ""
      }${media ? `\n${media}` : ""}${entry.tags
        .map((tag) => `\n      <category>${escapeXml(tag)}</category>`)
        .join("")}
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    <description>${escapeXml(feed.description)}</description>
    <link>${escapeXml(feed.link)}</link>
    <atom:link href="${escapeXml(feed.selfLink)}" rel="self" type="application/rss+xml"/>
    <language>${escapeXml(feed.language)}</language>${feed.icon ? `\n    <image>\n      <url>${escapeXml(feed.icon)}</url>\n      <title>${escapeXml(feed.title)}</title>\n      <link>${escapeXml(feed.link)}</link>\n    </image>` : ""}${feed.lastBuild ? `\n    <lastBuildDate>${new Date(feed.lastBuild).toUTCString()}</lastBuildDate>` : ""}
    <generator>${escapeXml(feed.generator)}</generator>
${items}
  </channel>
</rss>
`;
}

/** Atom 1.0, the format Mastodon clients and readers fall back to. */
export function renderAtomFeed(feed: ProfileFeed): string {
  const entries = feed.entries
    .map((entry) => {
      const enclosures = entry.attachments
        .map(
          (att) =>
            `    <link rel="enclosure" type="${escapeXml(att.mimeType)}" href="${escapeXml(att.url)}"${att.size ? ` length="${att.size}"` : ""}/>`
        )
        .join("\n");
      return `  <entry>
    <id>${escapeXml(entry.id)}</id>
    <title>${escapeXml(entry.title)}</title>
    <link rel="alternate" type="text/html" href="${escapeXml(entry.url)}"/>
    <published>${toIso(entry.published)}</published>
    <updated>${toIso(entry.published)}</updated>
    <author><name>${escapeXml(feed.title)}</name><uri>${escapeXml(feed.link)}</uri></author>
    <content type="html">${escapeXml(entry.html)}</content>${enclosures ? `\n${enclosures}` : ""}${entry.tags
        .map((tag) => `\n    <category term="${escapeXml(tag)}"/>`)
        .join("")}
  </entry>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(feed.language)}">
  <title>${escapeXml(feed.title)}</title>
  <subtitle>${escapeXml(feed.description)}</subtitle>
  <id>${escapeXml(feed.link)}</id>
  <link rel="alternate" type="text/html" href="${escapeXml(feed.link)}"/>
  <link rel="self" type="application/atom+xml" href="${escapeXml(feed.selfLink)}"/>
  <updated>${toIso(feed.lastBuild ?? new Date().toISOString())}</updated>${feed.icon ? `\n  <icon>${escapeXml(feed.icon)}</icon>\n  <logo>${escapeXml(feed.icon)}</logo>` : ""}
  <generator version="${escapeXml(feed.generator)}">${escapeXml(feed.generator)}</generator>
${entries}
</feed>
`;
}
