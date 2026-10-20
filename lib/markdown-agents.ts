/**
 * Markdown content negotiation ("Markdown for agents") — the **serving** side.
 *
 * (`lib/markdown.ts` is the authoring side: it turns the markdown a composer
 * sends into the HTML subset Mastodon displays. This module goes the other way,
 * for clients that ask for markdown.)
 *
 * A client that asks for `text/markdown` in its `Accept` header gets the
 * document built from our own data instead of the client-rendered HTML shell:
 * the status permalink and the profile pages are React views whose server HTML
 * carries no content (the data is fetched from the API in the browser), so
 * converting the shell — what an edge HTML→Markdown converter would do — would
 * return nothing useful.
 *
 * `acceptsMarkdown` implements the negotiation (q-values included, so a browser
 * sending `text/html` or the wildcard media range never gets markdown),
 * `htmlToMarkdown` converts the content HTML this app renders (the tag set
 * `lib/activitypub/sanitize.ts` allows: p/br/a/span/strong/em/code/pre/
 * blockquote/ul/ol/li/del/ruby/img) and the `*MarkdownDocument` builders
 * compose the pages. Everything is deterministic and synchronous: no AI
 * conversion, no per-request cost.
 */

/** The markdown media type we serve. */
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

/**
 * Whether the client prefers markdown over HTML for this request. A missing or
 * empty `Accept` (curl without headers) does **not** opt in.
 */
export function acceptsMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  const preferences = new Map<string, number>();
  for (const part of accept.split(",")) {
    const [typeRaw, ...params] = part.trim().split(";");
    const type = (typeRaw ?? "").trim().toLowerCase();
    if (!type) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.toLowerCase() === "q") {
        const parsed = Number.parseFloat(value ?? "");
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    preferences.set(type, Math.max(preferences.get(type) ?? 0, q));
  }
  const markdown = preferences.get("text/markdown") ?? preferences.get("text/x-markdown") ?? 0;
  if (markdown <= 0) return false;
  // `Accept: text/markdown` alone wins; anything that ranks HTML (or the
  // wildcard, which is what browsers send) at least as high does not.
  const html = Math.max(preferences.get("text/html") ?? 0, preferences.get("application/xhtml+xml") ?? 0);
  const wildcard = preferences.get("*/*") ?? 0;
  return markdown >= html && markdown >= wildcard;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") || entity.startsWith("#X")
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * A line that would be parsed as a markdown block (heading, list, quote…) is
 * escaped: the composer is plain text, so nothing the author typed is meant as
 * markup.
 */
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)([#>+\-*]|\d+\.)(\s)/, "$1\\$2$3"))
    .join("\n");
}

const TOKEN_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>|([^<]+)/g;

function attrValue(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

const INLINE_MARKER: Record<string, string> = {
  strong: "**",
  b: "**",
  em: "*",
  i: "*",
  code: "`",
  del: "~~",
  s: "~~",
};
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Their content is never text (the sanitizer removes them from stored content). */
const SKIP_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "math", "video", "audio",
  "form", "input", "textarea", "select", "button",
]);

/**
 * Convert the content HTML this app renders into markdown. Unknown tags are
 * dropped (their text is kept), so remote content that survived the sanitizer
 * never leaks markup.
 */
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  const out: string[] = [];
  let inPre = false;
  let skipDepth = 0;
  let quoteDepth = 0;
  let linkHref: string | null = null;
  let linkText = "";

  const newline = (count = 1) => {
    out.push("\n".repeat(count) + (quoteDepth > 0 ? "> ".repeat(quoteDepth) : ""));
  };
  const text = (value: string) => {
    if (!value) return;
    out.push(inPre ? value : escapeLineStarts(value));
  };

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(html)) !== null) {
    if (match[0].startsWith("<!--")) continue;
    if (match[4] != null) {
      if (skipDepth > 0) continue;
      const decoded = decodeEntities(match[4]);
      if (linkHref !== null) linkText += decoded;
      else text(decoded);
      continue;
    }

    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attrs = match[3] ?? "";

    if (skipDepth > 0) {
      if (closing && SKIP_CONTENT.has(tag)) skipDepth--;
      else if (!closing && SKIP_CONTENT.has(tag) && !match[0].endsWith("/>")) skipDepth++;
      continue;
    }
    if (!closing && SKIP_CONTENT.has(tag) && !match[0].endsWith("/>")) {
      skipDepth++;
      continue;
    }
    // Inside a fenced block nothing is inline markup: the text is emitted as-is.
    if (inPre && (INLINE_MARKER[tag] !== undefined || tag === "a")) continue;

    if (tag === "br") {
      newline();
      continue;
    }
    if (tag === "img") {
      // Custom emoji: the alt is the shortcode, which is what a reader wants
      // (an image URL in the middle of a sentence is noise).
      const alt = attrValue(attrs, "alt") ?? "";
      const src = attrValue(attrs, "src") ?? "";
      if (alt.startsWith(":") && alt.endsWith(":")) text(alt);
      else if (src) text(`![${alt}](${src})`);
      continue;
    }
    if (tag === "a") {
      if (closing) {
        const href = linkHref;
        const label = linkText.trim();
        linkHref = null;
        linkText = "";
        if (href) {
          // A bare URL is written as a bare URL (Mastodon's shortened links
          // render the visible part as the label and the full URL as the href).
          if (!label || label === href || label === href.replace(/^https?:\/\//, "")) text(href);
          else text(`[${label}](${href})`);
        } else {
          text(label);
        }
      } else {
        linkHref = attrValue(attrs, "href") ?? "";
      }
      continue;
    }
    if (HEADINGS.has(tag)) {
      if (!closing) {
        newline(2);
        out.push(`${"#".repeat(Number(tag[1]))} `);
      } else {
        newline(2);
      }
      continue;
    }
    if (tag === "p") {
      if (!closing) newline(out.length === 0 ? 0 : 2);
      else newline(2);
      continue;
    }
    if (tag === "blockquote") {
      // The blank lines belong outside the quote: emit them before entering it
      // and after leaving it, or the result grows empty ">" lines.
      if (closing) {
        quoteDepth = Math.max(0, quoteDepth - 1);
        newline(2);
      } else {
        newline(2);
        quoteDepth++;
      }
      continue;
    }
    if (tag === "pre") {
      if (!closing) {
        newline(2);
        out.push("```\n");
        inPre = true;
      } else {
        inPre = false;
        out.push("\n```");
        newline(2);
      }
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      newline(2);
      continue;
    }
    if (tag === "li") {
      if (!closing) {
        newline();
        out.push("- ");
      }
      continue;
    }
    if (tag === "hr") {
      newline(2);
      out.push("---");
      newline(2);
      continue;
    }
    if (tag === "ruby" || tag === "rt" || tag === "rp" || tag === "span" || tag === "u") continue;
    const marker = INLINE_MARKER[tag];
    if (marker) {
      text(marker);
      continue;
    }
    // Unknown tag: drop it, keep the text.
  }

  return out
    .join("")
    .replace(/^>+\s*$/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface MarkdownStatusInput {
  /** Human permalink. */
  url: string;
  /** ActivityPub object IRI. */
  apId: string;
  author: { acct: string; displayName: string; url: string };
  published: string;
  visibility: string;
  content: string | null;
  contentWarning?: string | null;
  attachments?: { type: string; url: string; description?: string | null }[];
  poll?: { options: { title: string; votes: number }[]; votesCount: number } | null;
  card?: { url: string; title?: string | null; description?: string | null } | null;
  counts: { replies: number; reblogs: number; favourites: number };
}

/** One status as a markdown document. */
export function statusMarkdownDocument(status: MarkdownStatusInput): string {
  const lines: string[] = [`# ${status.author.displayName} (@${status.author.acct})`, ""];
  if (status.contentWarning) lines.push(`> **${status.contentWarning}**`, "");
  lines.push(htmlToMarkdown(status.content) || "_(no text)_", "");

  if (status.attachments && status.attachments.length > 0) {
    lines.push("## Media", "");
    for (const media of status.attachments) {
      const description = media.description ? ` — ${media.description}` : "";
      if (media.type === "image") lines.push(`![${media.description ?? ""}](${media.url})`);
      else lines.push(`- [${media.type}](${media.url})${description}`);
    }
    lines.push("");
  }

  if (status.poll) {
    lines.push("## Poll", "");
    for (const option of status.poll.options) lines.push(`- ${option.title} — ${option.votes}`);
    lines.push("", `${status.poll.votesCount} vote(s)`, "");
  }

  if (status.card) {
    lines.push("## Link", "", `[${status.card.title ?? status.card.url}](${status.card.url})`);
    if (status.card.description) lines.push("", status.card.description);
    lines.push("");
  }

  lines.push(
    "---",
    "",
    `- Published: ${status.published}`,
    `- Visibility: ${status.visibility}`,
    `- Replies: ${status.counts.replies} · Boosts: ${status.counts.reblogs} · Favourites: ${status.counts.favourites}`,
    `- Permalink: ${status.url}`,
    `- ActivityPub: ${status.apId}`
  );
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export interface MarkdownAccountInput {
  acct: string;
  displayName: string;
  url: string;
  apId: string;
  note: string | null;
  fields?: { name: string; value: string }[];
  counts: { followers: number; following: number; statuses: number };
  createdAt?: string | null;
  /** Recent public posts, newest first. */
  posts?: { url: string; published: string; content: string | null; contentWarning?: string | null }[];
}

/** One profile (and its recent public posts) as a markdown document. */
export function accountMarkdownDocument(account: MarkdownAccountInput): string {
  const lines: string[] = [`# ${account.displayName} (@${account.acct})`, ""];
  const note = htmlToMarkdown(account.note);
  if (note) lines.push(note, "");

  if (account.fields && account.fields.length > 0) {
    lines.push("## Profile fields", "");
    for (const field of account.fields) {
      lines.push(`- **${field.name}**: ${htmlToMarkdown(field.value)}`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    `- Followers: ${account.counts.followers} · Following: ${account.counts.following} · Posts: ${account.counts.statuses}`
  );
  if (account.createdAt) lines.push(`- Joined: ${account.createdAt}`);
  lines.push(`- Profile: ${account.url}`, `- ActivityPub: ${account.apId}`);

  if (account.posts && account.posts.length > 0) {
    lines.push("", "## Recent posts", "");
    for (const post of account.posts) {
      lines.push(`### ${post.published}`, "", `[${post.url}](${post.url})`, "");
      if (post.contentWarning) lines.push(`> **${post.contentWarning}**`, "");
      lines.push(htmlToMarkdown(post.content) || "_(no text)_", "");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
