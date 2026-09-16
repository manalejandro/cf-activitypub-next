/**
 * Mastodon-compatible HTML sanitization for federated content.
 * Based on Mastodon's MASTODON_STRICT profile (lib/sanitize_ext/sanitize_config.rb).
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "span", "a", "del", "s", "pre", "blockquote", "code",
  "b", "strong", "u", "i", "em", "ul", "ol", "li", "ruby", "rt", "rp",
  "img",
]);

const VOID_TAGS = new Set(["br"]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const SKIP_CONTENT_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "textarea",
  "select", "button", "meta", "link", "base", "svg", "math", "video", "audio",
]);

const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "class", "translate"]),
  span: new Set(["class", "translate"]),
  p: new Set(["class"]),
  ol: new Set(["start", "reversed"]),
  li: new Set(["value"]),
  img: new Set(["src", "alt", "class", "title", "width", "height"]),
};

const GLOBAL_ATTRS = new Set(["lang"]);

const LINK_PROTOCOLS = new Set([
  "http", "https", "dat", "dweb", "ipfs", "ipns", "ssb", "gopher", "xmpp", "magnet", "gemini",
]);

const SEMANTIC_CLASSES = new Set(["mention", "hashtag", "ellipsis", "invisible", "tag", "quote-inline", "emojione"]);

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => decodeCodePoint(parseInt(dec, 10)));
}

function decodeCodePoint(cp: number): string {
  if (Number.isNaN(cp)) return "";
  if (cp === 0) return "\uFFFD";
  if (cp > 0x10ffff) return "\uFFFD";
  // Lone surrogates are invalid scalar values; map to U+FFFD like HTML does.
  if (cp >= 0xd800 && cp <= 0xdfff) return "\uFFFD";
  return String.fromCodePoint(cp);
}

function isAllowedClassName(name: string): boolean {
  if (SEMANTIC_CLASSES.has(name)) return true;
  return /^(h|p|u|dt|e)-/.test(name);
}

function filterClasses(raw: string | undefined): string {
  if (!raw) return "";
  const kept = raw.split(/[\t\n\f\r ]+/).filter(Boolean).filter(isAllowedClassName);
  return kept.join(" ");
}

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const m of raw.matchAll(re)) {
    attrs.set(m[1].toLowerCase(), decodeEntities(m[3] ?? m[4] ?? m[5] ?? ""));
  }
  return attrs;
}

/**
 * Normalize a URL and reject dangerous schemes. Control characters (tab, LF,
 * CR…) are stripped first: browsers ignore them inside schemes, so
 * `java\tscript:` would otherwise slip past the scheme check while still
 * executing as `javascript:` for consumers that set the HTML directly.
 * Returns the cleaned URL, or null when it must be dropped.
 */
function sanitizeUrl(raw: string, protocols: Set<string> = LINK_PROTOCOLS): string | null {
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("/") || cleaned.startsWith("#")) return cleaned;
  const match = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!match) return cleaned;
  return protocols.has(match[1].toLowerCase()) ? cleaned : null;
}

/** Only http(s) (and data images) may be embedded as media sources. */
const MEDIA_PROTOCOLS = new Set(["http", "https"]);

function serializeAttrs(tag: string, attrs: Map<string, string>): string {
  const allowed = TAG_ATTRS[tag] ?? new Set<string>();
  const parts: string[] = [];

  for (const [key, value] of attrs) {
    if (!GLOBAL_ATTRS.has(key) && !allowed.has(key)) continue;
    if (key === "class") {
      const filtered = filterClasses(value);
      if (filtered) parts.push(`class="${escapeHtml(filtered)}"`);
      continue;
    }
    if (key === "translate" && value !== "no") continue;
    if (key === "href") {
      const safe = sanitizeUrl(value);
      if (!safe) continue;
      parts.push(`href="${escapeHtml(safe)}"`);
      continue;
    }
    if (key === "src") {
      const safe = sanitizeUrl(value, MEDIA_PROTOCOLS);
      if (!safe) continue;
      parts.push(`src="${escapeHtml(safe)}"`);
      continue;
    }
    parts.push(`${key}="${escapeHtml(value)}"`);
  }

  if (tag === "a") {
    if (!parts.some((p) => p.startsWith('rel="'))) {
      parts.push('rel="nofollow noopener noreferrer"');
    }
    if (!parts.some((p) => p.startsWith('target="'))) {
      parts.push('target="_blank"');
    }
  }

  return parts.length ? " " + parts.join(" ") : "";
}

interface OpenTag {
  tag: string;
  heading?: boolean;
}

/** Strip all HTML and decode entities — for CW text and display names. */
export function sanitizeFediversePlain(input: string | null | undefined): string | null {
  if (input == null || input === "") return input ?? null;
  return decodeEntities(input.replace(/<[^>]*>/g, "")).trim() || null;
}

/** Sanitize federated HTML to Mastodon's allowed subset. */
export function sanitizeFediverseHtml(input: string | null | undefined): string | null {
  if (input == null || input === "") return input ?? null;

  const stack: OpenTag[] = [];
  let skipDepth = 0;
  let out = "";

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TAG_RE.exec(input)) !== null) {
    if (match[0].startsWith("<!--")) continue;

    const text = match[4];
    if (text != null) {
      if (skipDepth === 0) out += escapeHtml(decodeEntities(text));
      continue;
    }

    const closing = match[1] === "/";
    const rawTag = match[2].toLowerCase();
    const attrRaw = match[3] ?? "";

    if (skipDepth > 0) {
      if (!closing && !VOID_TAGS.has(rawTag) && SKIP_CONTENT_TAGS.has(rawTag)) skipDepth++;
      else if (closing && SKIP_CONTENT_TAGS.has(rawTag)) skipDepth--;
      continue;
    }

    if (closing) {
      if (HEADING_TAGS.has(rawTag)) {
        while (stack.length > 0) {
          const top = stack.pop()!;
          out += top.heading ? "</strong></p>" : `</${top.tag}>`;
          if (top.heading) break;
        }
        continue;
      }

      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === rawTag) {
          while (stack.length > i) {
            const top = stack.pop()!;
            out += top.heading ? "</strong></p>" : `</${top.tag}>`;
          }
          break;
        }
      }
      continue;
    }

    if (SKIP_CONTENT_TAGS.has(rawTag)) {
      if (!VOID_TAGS.has(rawTag)) skipDepth = 1;
      continue;
    }

    if (HEADING_TAGS.has(rawTag)) {
      out += "<p><strong>";
      stack.push({ tag: rawTag, heading: true });
      continue;
    }

    if (!ALLOWED_TAGS.has(rawTag)) continue;

    const attrs = parseAttrs(attrRaw);

    if (rawTag === "a" && attrs.has("href") && !sanitizeUrl(attrs.get("href")!)) {
      continue;
    }
    if ((rawTag === "img" || rawTag === "video" || rawTag === "audio" || rawTag === "source") &&
        attrs.has("src") && !sanitizeUrl(attrs.get("src")!, MEDIA_PROTOCOLS)) {
      continue;
    }

    const serialized = serializeAttrs(rawTag, attrs);
    if (VOID_TAGS.has(rawTag)) {
      out += `<${rawTag}${serialized}>`;
    } else {
      out += `<${rawTag}${serialized}>`;
      stack.push({ tag: rawTag });
    }
  }

  while (stack.length > 0) {
    const top = stack.pop()!;
    out += top.heading ? "</strong></p>" : `</${top.tag}>`;
  }

  return out || null;
}

export function sanitizeRemoteNoteContent(
  content: string | null | undefined,
  summary: string | null | undefined,
  sensitive: boolean
): { content: string | null; contentWarning: string | null } {
  return {
    content: sanitizeFediverseHtml(content),
    contentWarning: sensitive ? sanitizeFediversePlain(summary) : null,
  };
}

export function sanitizeRemoteActorSummary(summary: string | null | undefined): string | null {
  return sanitizeFediverseHtml(summary);
}
