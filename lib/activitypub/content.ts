/**
 * Content processing: converts plain-text status content to HTML,
 * linkifying @mentions and #hashtags.
 */

import type { APTag } from "@/lib/types";

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
 * Processes plain-text status content into HTML with linked mentions/hashtags.
 * Returns the HTML string and an array of AP tags (Mention / Hashtag) for use
 * in the ActivityPub Note `tag` field.
 */
export function processStatusContent(text: string, baseUrl?: string): { html: string; tags: APTag[] } {
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

  // 1. Remote mentions: @user@domain
  const remotePattern = /@([a-zA-Z0-9_.-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  for (const m of text.matchAll(remotePattern)) {
    const [full, user, domain] = m;
    const href = `https://${domain}/@${user}`;
    add(
      m.index!,
      m.index! + full.length,
      `<a href="${href}" class="u-url mention" rel="nofollow noopener noreferrer">@<span>${escapeHtml(user)}@${escapeHtml(domain)}</span></a>`,
      { type: "Mention", href, name: `@${user}@${domain}` }
    );
  }

  // 2. Local mentions: @user (not followed by @domain)
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

  // 3. Hashtags: #tag
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

  // 4. URLs (plain http/https links)
  const urlPattern = /\bhttps?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  for (const m of text.matchAll(urlPattern)) {
    const [url] = m;
    add(
      m.index!,
      m.index! + url.length,
      `<a href="${url}" target="_blank" rel="nofollow noopener noreferrer">${escapeHtml(url)}</a>`
    );
  }

  // Sort by start position and build HTML
  replacements.sort((a, b) => a.start - b.start);

  let result = "";
  let cursor = 0;
  for (const { start, end, html } of replacements) {
    result += escapeHtml(text.slice(cursor, start));
    result += html;
    cursor = end;
  }
  result += escapeHtml(text.slice(cursor));

  // Wrap in <p> tags (double newline = new paragraph, single newline = <br />)
  const paragraphs = result.split(/\n\n+/);
  const finalHtml = paragraphs
    .map((p) => `<p>${p.replace(/\n/g, "<br />")}</p>`)
    .join("");

  const tags = replacements.filter((r) => r.tag).map((r) => r.tag!);
  return { html: finalHtml, tags };
}
