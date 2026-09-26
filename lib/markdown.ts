/**
 * Safe Markdown subset for status authoring.
 *
 * Mastodon only *displays* rich text (it renders the HTML subset it receives),
 * and glitch-soc / GoToSocial / Akkoma let users *author* it as Markdown and
 * federate the resulting HTML. We do the same: the web composer sends
 * `content_type: text/markdown`, the API converts it here and the stored
 * federated HTML stays within what Mastodon can display.
 *
 * Supported: headings (`#`–`######`, rendered as the bold paragraphs Mastodon
 * shows), bold, italics, strikethrough, inline code, fenced code blocks,
 * blockquotes, ordered/unordered lists and `[text](https://url)` links.
 * Everything else stays literal; the caller's `inline` callback escapes and
 * linkifies mentions/hashtags/URLs first, so formatting never corrupts them.
 */

export interface MarkdownRenderOptions {
  /** Escape + linkify one plain-text inline segment (no block structure). */
  inline: (text: string) => string;
  /** Escape plain text only (code blocks/spans never get linkified). */
  escape: (text: string) => string;
}

/** Apply `fn` to text nodes only, leaving HTML tags untouched. */
function transformTextNodes(html: string, fn: (text: string) => string): string {
  return html
    .split(/(<[^>]+>)/)
    .map((chunk, index) => (index % 2 === 0 ? fn(chunk) : chunk))
    .join("");
}

function inlineFormat(html: string): string {
  // Bold, strikethrough and finally italics so `**` is consumed before `*`.
  // Each pass re-splits tags, so inserted HTML is never re-parsed.
  let out = transformTextNodes(html, (text) =>
    text.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, bold: string, alt: string) => `<strong>${bold ?? alt}</strong>`));
  out = transformTextNodes(out, (text) => text.replace(/~~([^~]+)~~/g, "<del>$1</del>"));
  out = transformTextNodes(out, (text) => text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>"));
  out = transformTextNodes(out, (text) =>
    text.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>"));
  return out;
}

/**
 * Inline code spans are protected before linkification so URLs/hashtags inside
 * them stay literal; `[text](url)` links are handled here because the
 * linkifier would otherwise turn the URL itself into an anchor first.
 */
function renderText(text: string, options: MarkdownRenderOptions): string {
  return text
    .split(/(`[^`]+`)/g)
    .map((part) =>
      part.length > 2 && part.startsWith("`") && part.endsWith("`")
        ? `<code>${options.escape(part.slice(1, -1))}</code>`
        : inlineFormat(options.inline(part))
    )
    .join("");
}

function renderInline(text: string, options: MarkdownRenderOptions): string {
  const out: string[] = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(linkRe)) {
    out.push(renderText(text.slice(cursor, match.index), options));
    out.push(
      `<a href="${options.escape(match[2])}" target="_blank" rel="nofollow noopener noreferrer">` +
      `${renderText(match[1], options)}</a>`
    );
    cursor = match.index + match[0].length;
  }
  out.push(renderText(text.slice(cursor), options));
  return out.join("");
}

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*```/;
const QUOTE_RE = /^\s*>\s?/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

function isBlockStart(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line);
}

/** Render Markdown block structure into the HTML subset Mastodon displays. */
export function renderMarkdown(text: string, options: MarkdownRenderOptions): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      const buffer: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buffer.push(lines[i]);
        i++;
      }
      i++; // closing fence (or end of text)
      out.push(`<pre><code>${options.escape(buffer.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      // Mastodon transforms h1–h6 into bold paragraphs when displaying, so
      // emit that directly: every client renders it the same way.
      out.push(`<p><strong>${renderInline(heading[2].trim(), options)}</strong></p>`);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buffer.push(lines[i].replace(QUOTE_RE, ""));
        i++;
      }
      out.push(`<blockquote>${buffer.map((l) => renderInline(l, options)).join("<br />")}</blockquote>`);
      continue;
    }

    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const item = LIST_RE.exec(lines[i]);
        if (!item) break;
        items.push(item[1]);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${renderInline(t, options)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      paragraph.push(lines[i]);
      i++;
    }
    out.push(`<p>${paragraph.map((l) => renderInline(l, options)).join("<br />")}</p>`);
  }

  return out.join("\n");
}
