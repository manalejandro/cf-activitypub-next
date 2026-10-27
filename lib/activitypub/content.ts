/**
 * Content processing: converts plain-text status content to HTML,
 * linkifying @mentions, #hashtags, and :shortcode: custom emoji.
 */

import type { APTag } from "@/lib/types";
import { renderMarkdown } from "@/lib/markdown";
import { maskMarkdownCode } from "@/lib/markdown-code";
import { safeMediaUrl } from "@/lib/safe-url";
import type { EmojiLike } from "@/lib/types";

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

/** A mention that resolved to a real account. */
export interface ResolvedMention {
  /** Canonical actor IRI. */
  href: string;
}

/**
 * Mentions the renderer is allowed to linkify, keyed by handle: `user` for a
 * local mention and `user@domain` for a remote one (both lowercased). With a
 * map, an `@word` that is not in it stays plain text — a link to a profile that
 * does not exist (or, for a remote `@word`, to our own local profile) is worse
 * than no link at all.
 */
export type MentionsMap = Map<string, ResolvedMention>;

const REMOTE_MENTION_RE = /@([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const LOCAL_MENTION_RE = /(?<![a-zA-Z0-9_.-])@([a-zA-Z0-9_]+)(?![@a-zA-Z0-9_.-])/g;

/** Handles a text mentions, split into local (`@user`) and remote (`@user@domain`). */
export function extractMentionHandles(text: string): {
  local: string[];
  remote: { user: string; domain: string }[];
} {
  const remote: { user: string; domain: string }[] = [];
  for (const m of text.matchAll(REMOTE_MENTION_RE)) {
    remote.push({ user: m[1], domain: m[2] });
  }
  const local: string[] = [];
  for (const m of text.matchAll(LOCAL_MENTION_RE)) {
    local.push(m[1]);
  }
  return { local, remote };
}

/**
 * Builds the ordered list of link replacements for plain-text content
 * (custom emoji, URLs, remote/local mentions, hashtags). Shared by
 * `processStatusContent` and `linkifyInline`.
 */
function buildReplacements(
  text: string,
  baseUrl?: string,
  customEmojis?: EmojiLike[],
  mentions?: MentionsMap | null
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
    // The instance's own emoji wins a shortcode collision with a federated one:
    // a remote server must not be able to shadow (or substitute) a local
    // shortcode, and the catalogue order is not a guarantee.
    const emojiMap = new Map<string, EmojiLike>();
    for (const e of customEmojis) {
      const current = emojiMap.get(e.shortcode);
      if (current && !current.domain && e.domain) continue;
      emojiMap.set(e.shortcode, e);
    }
    const emojiPattern = /:([a-zA-Z0-9_]+):/g;
    for (const m of text.matchAll(emojiPattern)) {
      const [full, code] = m;
      const emoji = emojiMap.get(code);
      // The URL comes from a federated document and this string is built AFTER
      // the sanitizer ran, so it is validated and escaped here: an unescaped
      // `"` broke out of `src` and turned a status into stored XSS.
      const emojiUrl = emoji ? safeMediaUrl(emoji.url) : null;
      if (emoji && emojiUrl) {
        const escaped = escapeHtml(emojiUrl);
        // Mastodon's Emoji tag declares the real media type of the image
        // (a GIF emoji announced as image/png is rejected by stricter peers).
        const mediaType = /\.gif(\?|$)/i.test(emojiUrl)
          ? "image/gif"
          : /\.jpe?g(\?|$)/i.test(emojiUrl)
            ? "image/jpeg"
            : "image/png";
        add(
          m.index!,
          m.index! + full.length,
          `<img src="${escaped}" alt=":${code}:" class="emojione custom-emoji" rel="emoji" title=":${code}:" width="16" height="16" />`,
          { type: "Emoji", name: `:${code}:`, icon: { type: "Image", id: emojiUrl, url: emojiUrl, mediaType } }
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
  // target and as an accessible hover title. A handle that resolved to no
  // account stays plain text when a resolution map is provided. The href of a
  // resolved mention comes from the stored AP tag (remote-controlled): it is
  // URL-validated and attribute-escaped — this runs AFTER the sanitizer, so an
  // unescaped `"` or a `javascript:` URL would survive into `content`.
  for (const m of text.matchAll(REMOTE_MENTION_RE)) {
    const [full, user, domain] = m;
    const resolved = mentions?.get(`${user}@${domain}`.toLowerCase());
    if (mentions && !resolved) continue;
    const href = safeMediaUrl(resolved?.href ?? `https://${domain}/@${user}`);
    if (!href) continue;
    add(
      m.index!,
      m.index! + full.length,
      `<a href="${escapeHtml(href)}" class="u-url mention" rel="nofollow noopener noreferrer" title="@${escapeHtml(user)}@${escapeHtml(domain)}">@<span>${escapeHtml(user)}</span></a>`,
      { type: "Mention", href, name: `@${user}@${domain}` }
    );
  }

  // 3. Local mentions: @user (not followed by @domain)
  const localDomain = baseUrl ? new URL(baseUrl).hostname : undefined;
  for (const m of text.matchAll(LOCAL_MENTION_RE)) {
    const [full, user] = m;
    const resolved = mentions?.get(user.toLowerCase());
    if (mentions && !resolved) continue;
    const href = safeMediaUrl(resolved?.href ?? (baseUrl ? `${baseUrl}/users/${user}` : `/users/${user}`));
    if (!href) continue;
    const name = localDomain ? `@${user}@${localDomain}` : `@${user}`;
    add(
      m.index!,
      m.index! + full.length,
      `<a href="${escapeHtml(href)}" class="u-url mention">@<span>${escapeHtml(user)}</span></a>`,
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
function buildHtml(
  text: string,
  replacements: Replacement[],
  options: { convertNewlines?: boolean } = {}
): string {
  let result = "";
  let cursor = 0;
  for (const { start, end, html } of replacements) {
    result += escapeHtml(text.slice(cursor, start));
    result += html;
    cursor = end;
  }
  result += escapeHtml(text.slice(cursor));
  // Plain-text input relies on newlines becoming <br />; real HTML text nodes
  // must keep them as whitespace (a newline between </p> and <p> is not a line
  // break, and converting it added stray <br /> in serialized content).
  return options.convertNewlines === false ? result : result.replace(/\n/g, "<br />");
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
/**
 * Turn the emoji `<img>` tags we render for local content back into
 * `:shortcode:` text.
 *
 * Mastodon's actor documents carry the *source* note (shortcodes) plus the
 * `tag` array and render the emojis themselves; a summary that only holds an
 * `<img>` shows no emoji at all there (their sanitizer drops the image and the
 * emoji formatter has no shortcode to replace). Notes keep the image (Mastodon
 * sends emoji images in note content), actors send the shortcode.
 */
export function emojiImgsToShortcodes(html: string): string {
  if (!html || !html.includes("emojione")) return html;
  return html.replace(/<img\b[^>]*>/g, (tag) => {
    if (!/class="[^"]*\bemojione\b/.test(tag)) return tag;
    const alt = tag.match(/\balt=":([a-zA-Z0-9_]+):"/);
    return alt ? `:${alt[1]}:` : tag;
  });
}

/**
 * Profile-field values are verified by the *receiving* instance: Mastodon's
 * `Account::Field#extract_url_from_html` only accepts a single anchor whose
 * `href` equals its text, so a plain URL never becomes verifiable and the field
 * never gets its checkmark. Wrap https values; leave anything else as typed.
 */
export function fieldValueForVerification(value: string): string {
  const url = value.trim();
  if (!/^https:\/\/[^\s<>"]+$/i.test(url)) return value;
  const escaped = url.replace(/&/g, "&amp;");
  return `<a href="${escaped}" rel="me">${escaped}</a>`;
}

export function linkifyInline(
  text: string,
  baseUrl?: string,
  customEmojis?: EmojiLike[],
  options: { convertNewlines?: boolean; mentions?: MentionsMap | null } = {}
): string {
  return buildHtml(text, buildReplacements(text, baseUrl, customEmojis, options.mentions), options);
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
  customEmojis?: EmojiLike[],
  mentions?: MentionsMap | null
): string {
  let out = "";
  let skip = 0; // depth of protected elements (a, pre, code)
  HTML_WALK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_WALK_RE.exec(html)) !== null) {
    const text = match[4];
    if (text != null) {
      if (skip === 0) {
        // Real HTML text nodes: keep newlines as whitespace (browsers collapse
        // them) instead of turning them into line breaks.
        out += linkifyInline(decodeHtmlEscapes(text), baseUrl, customEmojis, { convertNewlines: false, mentions });
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
 * Derive the local attachment type (image/gifv/video/audio/unknown) for a
 * federated attachment. Mastodon sends every attachment as AP type "Document"
 * and only distinguishes the media kind via `mediaType` (a MIME string), so the
 * MIME wins when present. A document MIME (PDF, plain text, office files…) is
 * the `unknown` type Mastodon clients render as a download link — never an
 * image, which is what a PDF used to become. `application/octet-stream` is
 * excluded from that rule because peers send it for photos too; without a
 * useful MIME the AP type is the fallback (an untyped "Document" is an image,
 * the historical Mastodon shape) after a last hint from the URL extension.
 */
export function apAttachmentType(
  apType: string | null | undefined,
  mediaType: string | null | undefined,
  url?: string | null
): string {
  const mt = (mediaType ?? "").toLowerCase();
  if (mt.startsWith("image/")) return mt === "image/gif" ? "gifv" : "image";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  if (mt && mt !== "application/octet-stream" && (mt.startsWith("application/") || mt.startsWith("text/"))) {
    return "unknown";
  }
  const path = (url ?? "").toLowerCase().split(/[?#]/)[0];
  if (/\.(pdf|txt|md|csv|zip|docx?|xlsx?|pptx?|odt|ods|epub)$/.test(path)) return "unknown";
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
export interface ProcessStatusContentOptions {
  /**
   * Author content as Markdown (the glitch-soc / GoToSocial / Akkoma
   * `content_type: text/markdown` convention). The rendered HTML stays within
   * the subset Mastodon can display.
   */
  markdown?: boolean;
  /**
   * Mentions allowed to become links (see `MentionsMap`). Callers with DB
   * access resolve them first (`resolveMentionLinks`); when omitted every
   * `@word` is linkified, which is only right for text that was never meant to
   * mention anyone (settings pages, announcements).
   */
  mentions?: MentionsMap | null;
}

export function processStatusContent(
  text: string,
  baseUrl?: string,
  customEmojis?: EmojiLike[],
  options: ProcessStatusContentOptions = {}
): { html: string; tags: APTag[] } {
  const replacements = buildReplacements(text, baseUrl, customEmojis, options.mentions);

  if (options.markdown) {
    // Tags come from the text OUTSIDE code samples: `@options` or `#quote`
    // inside a fenced block is source code, never a mention or hashtag.
    const tags = buildReplacements(maskMarkdownCode(text), baseUrl, customEmojis, options.mentions)
      .filter((r) => r.tag)
      .map((r) => r.tag!);
    return {
      html: renderMarkdown(text, {
        inline: (segment) => linkifyInline(segment, baseUrl, customEmojis, { mentions: options.mentions }),
        escape: escapeHtml,
      }),
      tags,
    };
  }

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
