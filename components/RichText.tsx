"use client";

/**
 * Safe rich-text renderer for federated HTML content.
 *
 * Content from the fediverse is already sanitized server-side
 * (lib/activitypub/sanitize.ts). This component parses that sanitized HTML
 * into React elements using a strict tag/attribute whitelist that mirrors the
 * server sanitizer, so React escapes all text and attribute values — no
 * `dangerouslySetInnerHTML` needed.
 */

import { memo, createElement, type ReactNode } from "react";
import Link from "next/link";

const ALLOWED_TAGS = new Set([
  "p", "br", "span", "a", "del", "s", "pre", "blockquote", "code",
  "b", "strong", "u", "i", "em", "ul", "ol", "li", "ruby", "rt", "rp",
  "img",
]);

const VOID_TAGS = new Set(["br", "img"]);

const ATTR_MAP: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "class", "translate", "target"]),
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

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isAllowedClass(name: string): boolean {
  if (["mention", "hashtag", "ellipsis", "invisible", "tag", "quote-inline", "emojione"].includes(name)) return true;
  return /^(h|p|u|dt|e)-/.test(name);
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return true;
  const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!match) return true;
  return LINK_PROTOCOLS.has(match[1].toLowerCase());
}

interface OpenNode {
  tag: string;
  props: Record<string, unknown>;
  children: ReactNode[];
}

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const m of raw.matchAll(re)) {
    attrs.set(m[1].toLowerCase(), decodeEntities(m[3] ?? m[4] ?? m[5] ?? ""));
  }
  return attrs;
}

function buildProps(tag: string, attrs: Map<string, string>): Record<string, unknown> {
  const allowed = ATTR_MAP[tag] ?? new Set<string>();
  const props: Record<string, unknown> = {};

  for (const [key, value] of attrs) {
    if (key === "class") {
      const kept = value.split(/[\t\n\f\r ]+/).filter(Boolean).filter(isAllowedClass);
      if (kept.length > 0) props.className = kept.join(" ");
      continue;
    }
    if (key === "href") {
      if (isSafeHref(value)) props.href = value;
      continue;
    }
    if (key === "src") {
      if (isSafeHref(value)) props.src = value;
      continue;
    }
    if (!GLOBAL_ATTRS.has(key) && !allowed.has(key)) continue;
    if (key === "translate" && value !== "no") continue;
    if (key === "target" && value !== "_blank") continue;
    props[key] = value;
  }

  if (tag === "a" && props.href) {
    const rel = String(props.rel ?? "");
    if (!rel.split(/\s+/).includes("nofollow")) props.rel = rel ? `${rel} nofollow noopener noreferrer` : "nofollow noopener noreferrer";
  }

  return props;
}

export function toReactNodes(html: string): ReactNode[] {
  const roots: ReactNode[] = [];
  const stack: OpenNode[] = [];
  let keySeq = 0;

  const push = (node: ReactNode) => {
    const top = stack[stack.length - 1];
    if (top) top.children.push(node);
    else roots.push(node);
  };

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html)) !== null) {
    if (match[0].startsWith("<!--")) continue;

    const text = match[4];
    if (text != null) {
      push(decodeEntities(text));
      continue;
    }

    const closing = match[1] === "/";
    const rawTag = match[2].toLowerCase();
    const attrRaw = match[3] ?? "";

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === rawTag) {
          const closed = stack.splice(i)[0];
          // Internal links (start with "/" but not "//") render as Next.js Links
          // so navigation stays client-side and in-memory caches survive;
          // external links stay plain anchors.
          const isInternalLink =
            closed.tag === "a" &&
            typeof closed.props.href === "string" &&
            closed.props.href.startsWith("/") &&
            !closed.props.href.startsWith("//");
          const element = createElement(isInternalLink ? (Link as React.ElementType) : closed.tag, { ...closed.props, key: keySeq++ }, ...closed.children);
          push(element);
          break;
        }
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(rawTag)) continue;

    const props = buildProps(rawTag, parseAttrs(attrRaw));

    // Mirror the server sanitizer: an <a> with a disallowed href is dropped
    // entirely (its inner content is still kept as plain text).
    if (rawTag === "a" && !props.href) continue;

    if (VOID_TAGS.has(rawTag)) {
      push(createElement(rawTag, { ...props, key: keySeq++ }));
      continue;
    }

    stack.push({ tag: rawTag, props, children: [] });
  }

  while (stack.length > 0) {
    const top = stack.pop()!;
    push(createElement(top.tag, { ...top.props, key: keySeq++ }, ...top.children));
  }

  return roots;
}

export function RichText({ html }: { html: string }) {
  return <>{toReactNodes(html)}</>;
}

export const MemoRichText = memo(RichText);