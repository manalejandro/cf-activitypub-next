/**
 * Content processing: converts plain-text status content to HTML,
 * linkifying @mentions, #hashtags, and :shortcode: custom emoji.
 */

import type { APTag } from "@/lib/types";
import type { LocalCustomEmoji } from "@/lib/types";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Replacement {
  start: number;
  end: number;
  html: string;
  tag?: APTag;
}

/**
 * Builds the ordered list of link replacements for plain-text content
 * (custom emoji, URLs, remote/local mentions, hashtags). Shared by
 * `processStatusContent` and `linkifyInline`.
 */
function buildReplacements(
  text: string,
  baseUrl?: string,
  customEmojis?: LocalCustomEmoji[]
): Replacement[] {
  const replacements: Replacement[] = [];
  const usedRanges: [number, number][] = [];

  const overlaps = (start: number, end: number): boolean => {
    for (const [s, e] of usedRanges) {
      if (start < e && end > s) return true;
    }
    return false;
  };

  const add = (start: number, end: number, html: string, tag?: APTag) => {
    if (!overlaps(start, end)) {
      usedRanges.push([start, end]);
      replacements.push({ start, end, html, tag });
    }
  };

  // 0. Custom emoji shortcodes: :shortcode:
  if (customEmojis && customEmojis.length > 0) {
    const emojiMap = new Map(customEmojis.map((e) => [e.shortcode, e]));
    const emojiPattern = /:([a-zA-Z0-9_]+):/g;
    for (const m of text.matchAll(emojiPattern)) {
      const [full, code] = m;
      const emoji = emojiMap.get(code);
      if (emoji) {
        add(
          m.index!,
          m.index! + full.length,
          `<img src="${emoji.url}" alt=":${code}:" class="emojione" title=":${code}:" width="16" height="16" />`,
          { type: "Emoji", name: `:${code}:`, icon: { type: "Image", id: emoji.url, url: emoji.url, mediaType: "image/png" } }
        );
      }
    }
  }

  // 1. URLs (plain http/https links) — processed before mentions and hashtags
  // so that any `@account` (and `#fragment` / trailing `#`) inside a link is
  // reserved as part of the URL and never misparsed as a mention or hashtag.
  const urlPattern = /\bhttps?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  for (const m of text.matchAll(urlPattern)) {
    const [url] = m;
    add(
      m.index!,
      m.index! + url.length,
      `<a href="${url}" target="_blank" rel="nofollow noopener noreferrer">${escapeHtml(url)}</a>`
    );
  }

  // 2. Remote mentions: @user@domain.
  // Display only the username (@user), keeping the full handle as the link
  // target and as an accessible hover title.
  const remotePattern = /@([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  for (const m of text.matchAll(remotePattern)) {
    const [full, user, domain] = m;
    const href = `https://${domain}/@${user}`;
    add(
      m.index!,
      m.index! + full.length,
      `<a href="${href}" class="u-url mention" rel="nofollow noopener noreferrer" title="@${escapeHtml(user)}@${escapeHtml(domain)}">@<span>${escapeHtml(user)}</span></a>`,
      { type: "Mention", href, name: `@${user}@${domain}` }
    );
  }

  // 3. Local mentions: @user (not followed by @domain)
  const localDomain = baseUrl ? new URL(baseUrl).hostname : undefined;
  const localPattern = /(?<![a-zA-Z0-9_.-])@([a-zA-Z0-9_]+)(?![@a-zA-Z0-9_.-])/g;
  for (const m of text.matchAll(localPattern)) {
    const [full, user] = m;
    const href = baseUrl ? `${baseUrl}/users/${user}` : `/users/${user}`;
    const name = localDomain ? `@${user}@${localDomain}` : `@${user}`;
    add(
      m.index!,
      m.index! + full.length,
      `<a href="${href}" class="u-url mention">@<span>${escapeHtml(user)}</span></a>`,
      { type: "Mention", href, name }
    );
  }

  // 4. Hashtags: #tag (skipped when the range belongs to an already-reserved URL)
  const hashPattern = /#([a-zA-Z\u00C0-\u024F\u0400-\u04FF][a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF_]*)/g;
  for (const m of text.matchAll(hashPattern)) {
    const [full, tag] = m;
    const href = `/tags/${tag.toLowerCase()}`;
    add(
      m.index!,
      m.index! + full.length,
      `<a href="${href}" class="tag" rel="tag">#${escapeHtml(tag)}</a>`,
      { type: "Hashtag", href, name: `#${tag}` }
    );
  }

  replacements.sort((a, b) => a.start - b.start);
  return replacements;
}

/**
 * Joins a sorted list of replacements with the surrounding escaped plain text,
 * preserving single newlines (converted to <br /> inline).
 */
function buildHtml(text: string, replacements: Replacement[]): string {
  let result = "";
  let cursor = 0;
  for (const { start, end, html } of replacements) {
    result += escapeHtml(text.slice(cursor, start));
    result += html;
    cursor = end;
  }
  result += escapeHtml(text.slice(cursor));
  return result.replace(/\n/g, "<br />");
}

/**
 * Convert a local actor's stored note (escaped plain text with <br />) back to
 * plain text so it can be re-linkified. Remote summaries are real HTML and must
 * not be touched.
 */
export function localSummaryToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Convert status HTML back to the plain text a user would type in the editor,
 * restoring the full `@user@domain` handle for mention links. Mentions are
 * rendered with the domain only in the `title` attribute (display shows just
 * `@user`), so a naive `textContent` strip would drop the remote domain and
 * cause the mention to be re-parsed as a local one on the next save.
 */
export function statusHtmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<p\b[^>]*>/gi, "\n")
    .replace(/<a\b[^>]*?\btitle="(@[^"]+)"[^>]*>.*?<\/a>/gi, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Linkifies plain text into inline HTML (URLs, mentions, hashtags, custom
 * emoji) WITHOUT paragraph wrapping. Used for profile bios and field values,
 * where a <p> wrapper would add unwanted block margins.
 */
export function linkifyInline(
  text: string,
  baseUrl?: string,
  customEmojis?: LocalCustomEmoji[]
): string {
  return buildHtml(text, buildReplacements(text, baseUrl, customEmojis));
}

const HTML_WALK_RE = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;

/**
 * Linkifies any still-unlinked URLs, @mentions, #hashtags and :emoji: shortcodes
 * found in the text nodes of already-sanitized federated HTML.
 *
 * Some servers (PeerTube, WordPress, several bridges) wrap their plain text in
 * `<p>` tags without ever turning URLs, mentions or hashtags into `<a>` links.
 * This walks the sanitized HTML and linkifies only the text that is NOT already
 * inside an `<a>`, `<pre>` or `<code>` element, so already-linked content (e.g.
 * Mastodon) is left untouched while plain text gets the same treatment as local
 * statuses.
 */
export function linkifyHtmlText(
  html: string,
  baseUrl?: string,
  customEmojis?: LocalCustomEmoji[]
): string {
  let out = "";
  let skip = 0; // depth of protected elements (a, pre, code)
  HTML_WALK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_WALK_RE.exec(html)) !== null) {
    const text = match[4];
    if (text != null) {
      if (skip === 0) {
        out += linkifyInline(decodeHtmlEscapes(text), baseUrl, customEmojis);
      } else {
        out += text;
      }
      continue;
    }
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    if (tag === "a" || tag === "pre" || tag === "code") {
      if (!closing) skip++;
      else skip = Math.max(0, skip - 1);
    }
    out += match[0];
  }
  return out;
}

function decodeHtmlEscapes(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Derive the local media type (image/gifv/video/audio) for a federated
 * attachment. Mastodon sends every attachment as AP type "Document" and only
 * distinguishes the media kind via `mediaType` (a MIME string), so the MIME
 * wins when present. Falls back to the AP type lowercased, defaulting an
 * untyped/"Document" attachment to "image".
 */
export function apAttachmentType(
  apType: string | null | undefined,
  mediaType: string | null | undefined
): string {
  const mt = (mediaType ?? "").toLowerCase();
  if (mt.startsWith("image/")) return mt === "image/gif" ? "gifv" : "image";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  const t = (apType ?? "").toLowerCase();
  if (!t || t === "document") return "image";
  return t;
}

/**
 * Processes plain-text status content into HTML with linked mentions/hashtags
 * and custom emoji shortcodes.
 * Returns the HTML string and an array of AP tags (Mention / Hashtag / Emoji)
 * for use in the ActivityPub Note `tag` field.
 */
export function processStatusContent(
  text: string,
  baseUrl?: string,
  customEmojis?: LocalCustomEmoji[]
): { html: string; tags: APTag[] } {
  const replacements = buildReplacements(text, baseUrl, customEmojis);

  // Sort by start position and build HTML
  let result = "";
  let cursor = 0;
  for (const { start, end, html } of replacements) {
    result += escapeHtml(text.slice(cursor, start));
    result += html;
    cursor = end;
  }
  result += escapeHtml(text.slice(cursor));

  // Wrap in <p> tags (double newline = new paragraph, single newline = <br />)
  // Using split(/\n\n/) instead of /\n\n+/ so extra blank lines become <br />
  // inside the following paragraph, preserving intentional spacing.
  const paragraphs = result.split(/\n\n/).filter(Boolean);
  const finalHtml = paragraphs
    .map((p) => `<p>${p.replace(/\n/g, "<br />")}</p>`)
    .join("");

  const tags = replacements.filter((r) => r.tag).map((r) => r.tag!);
  return { html: finalHtml, tags };
}
