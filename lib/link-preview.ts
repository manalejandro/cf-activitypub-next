/**
 * Link preview cards (Mastodon `PreviewCard` / `FetchLinkCardService`).
 *
 * When a status containing a link is created (locally or federated), the link
 * is queued and crawled asynchronously by the cron: the first external URL is
 * fetched with the same user-agent fallback as the media cache, an oEmbed
 * endpoint is tried first, then OpenGraph/Twitter Card/JSON-LD metadata is
 * parsed. The resulting card is shared by every status that links to the same
 * URL and snapshotted onto each status (`objects.card_json`) so every
 * serializer exposes it without extra queries.
 *
 * When the media cache is enabled the preview image is queued there too
 * (`media_cache.target_type = 'card'`), so it is served from R2 instead of the
 * origin server. Mirrors Mastodon: first URL only, no card when the status has
 * media or a quote, cards refreshed after `LINK_PREVIEW_DAYS` and negative
 * cached when a URL produces nothing usable.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { LocalObject } from "@/lib/types";
import type { InstanceLimits } from "@/lib/constants";
import { validateOutboundUrl } from "@/lib/activitypub/federation";
import { decodeStatusId, encodeStatusId } from "@/lib/mastodon/statusId";
import { fetchWithUserAgents, readBoundedBytes } from "@/lib/media/fetch";
import {
  cleanupOrphanPreviewCards,
  deleteLinkPreviewQueue,
  enqueueLinkPreview,
  enqueueMediaCache,
  getActorById,
  getAttachmentsByObjectId,
  getMediaCacheStatusBySourceUrl,
  getObjectById,
  getPreviewCardBySourceUrl,
  linkObjectPreviewCard,
  listLinkPreviewQueue,
  markLinkPreviewFailed,
  markPreviewCardFailed,
  mediaCacheId,
  updateObjectCardSnapshots,
  upsertPreviewCard,
  type PreviewCardInput,
} from "@/lib/db";

export interface LinkPreviewKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface LinkPreviewBindings {
  DB: D1Database;
  /** Optional: per-URL crawl locks (best-effort). */
  KV?: LinkPreviewKV;
}

export interface LinkPreviewLimits {
  enabled?: boolean;
  fetchBatch?: number;
  days?: number;
  maxBytes?: number;
  userAgents?: string[];
  linkPreviewEnabled?: boolean;
  linkPreviewFetchBatch?: number;
  linkPreviewDays?: number;
  linkPreviewMaxBytes?: number;
  /** Same list as the media cache (`mediaCacheUserAgents`). */
  mediaCacheUserAgents?: string[];
  mediaCacheEnabled?: boolean;
}

export interface NormalizedLinkPreviewLimits {
  enabled: boolean;
  fetchBatch: number;
  days: number;
  maxBytes: number;
  userAgents: string[];
  mediaCacheEnabled: boolean;
}

/**
 * Bridge from `resolveLimits()` (prefixed fields) to this module. The user
 * agents and the cache-enabled flag are shared with the media cache on
 * purpose: link previews must present the same client to origins.
 */
export function linkPreviewLimitsFrom(limits: InstanceLimits): LinkPreviewLimits {
  return {
    enabled: limits.linkPreviewEnabled,
    fetchBatch: limits.linkPreviewFetchBatch,
    days: limits.linkPreviewDays,
    maxBytes: limits.linkPreviewMaxBytes,
    userAgents: limits.mediaCacheUserAgents,
    mediaCacheEnabled: limits.mediaCacheEnabled,
  };
}

function normalizeLimits(limits: LinkPreviewLimits): NormalizedLinkPreviewLimits {
  const pick = <T>(plain: T | undefined, prefixed: T | undefined): T | undefined =>
    plain !== undefined ? plain : prefixed;
  const fetchBatch = Number(pick(limits.fetchBatch, limits.linkPreviewFetchBatch));
  const days = Number(pick(limits.days, limits.linkPreviewDays));
  const maxBytes = Number(pick(limits.maxBytes, limits.linkPreviewMaxBytes));
  const userAgents = pick(limits.userAgents, limits.mediaCacheUserAgents);
  const enabled = pick(limits.enabled, limits.linkPreviewEnabled);
  const mediaCacheEnabled = limits.mediaCacheEnabled;
  return {
    enabled: enabled !== false,
    fetchBatch: fetchBatch > 0 ? fetchBatch : 5,
    days: days > 0 ? days : 14,
    maxBytes: maxBytes > 0 ? maxBytes : 2 * 1024 * 1024,
    userAgents: Array.isArray(userAgents) && userAgents.length > 0
      ? userAgents
      : ["cf-activitypub/0.1.0 (+https://localhost; federated media cache)"],
    mediaCacheEnabled: mediaCacheEnabled !== false,
  };
}

const PAGE_TIMEOUT_MS = 12_000;
const OEMBED_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const RETRY_HOURS = [1, 6, 24];
const NEGATIVE_CACHE_HOURS = 24 * 7;
const MAX_QUEUE_BUDGET_MS = 25_000;
const LOCK_TTL_SECONDS = 60;

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"{}|\\^`[\]]+/g;

// ─────────────────────────────────────────
// Small HTML helpers (Workers have no DOM)
// ─────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", middot: "·", copy: "©", reg: "®", trade: "™",
  deg: "°", euro: "€", pound: "£", yen: "¥", times: "×", divide: "÷",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1]?.toLowerCase() === "x";
      const value = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(value) && value > 0 && value <= 0x10ffff) {
        try { return String.fromCodePoint(value); } catch { return match; }
      }
      return match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const match of tag.matchAll(re)) {
    attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function parseMetaTags(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = parseAttributes(tag);
    const key = (attrs.property ?? attrs.name ?? "").trim().toLowerCase();
    if (key && attrs.content !== undefined && !map.has(key)) map.set(key, attrs.content.trim());
  }
  return map;
}

function parseLinkTags(html: string): Record<string, string>[] {
  return (html.match(/<link\b[^>]*>/gi) ?? []).map((tag) => parseAttributes(tag));
}

function decodeHtml(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 2048));
  const fromHeader = contentTypeHeader?.match(/charset\s*=\s*["']?([\w.-]+)/i)?.[1];
  const fromMeta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.-]+)/i)?.[1]
    ?? head.match(/content\s*=\s*["'][^"'>]*charset=([\w.-]+)/i)?.[1];
  const label = (fromHeader ?? fromMeta ?? "utf-8").toLowerCase();
  if (label !== "utf-8" && label !== "utf8") {
    try { return new TextDecoder(label).decode(bytes); } catch { /* unsupported label */ }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function resolveUrl(value: string | undefined | null, base: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

function httpsUrl(value: string | undefined | null, base: string): string | null {
  const resolved = resolveUrl(value, base);
  if (!resolved) return null;
  try {
    const url = new URL(resolved);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildIframe(src: string, width: number, height: number): string {
  return `<iframe src="${escapeHtmlAttr(src)}" width="${width}" height="${height}" allowfullscreen="true" allowtransparency="true" scrolling="no" frameborder="0"></iframe>`;
}

function normalizeLocale(value: string | undefined | null): string | null {
  if (!value) return null;
  const locale = value.trim().replace(/_/g, "-");
  return /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(locale) ? locale : null;
}

function normalizeDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function positiveInt(value: string | number | undefined | null): number {
  const n = Math.floor(Number(value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ─────────────────────────────────────────
// Link extraction
// ─────────────────────────────────────────

const PROFILE_HREF = /^https?:\/\/[^/]+\/@[^/?#]+$/i;
const TAG_HREF = /^https?:\/\/[^/]+\/(tags?|explore\/tags)\//i;

/**
 * First external link in a status body (Mastodon picks only the first).
 * Anchors that are hashtags, mentions or microformats are skipped, as are
 * links pointing back at this instance.
 */
export function extractFirstLink(content: string | null | undefined, ownDomain?: string | null): string | null {
  if (!content) return null;
  const own = ownDomain?.toLowerCase();

  const isOwn = (url: string): boolean => {
    if (!own) return false;
    try { return new URL(url).hostname.toLowerCase() === own; } catch { return false; }
  };
  const acceptable = (url: string): boolean => {
    if (!/^https?:\/\//i.test(url)) return false;
    if (PROFILE_HREF.test(url) || TAG_HREF.test(url)) return false;
    // Own links are skipped (no self-crawling) except status permalinks: they
    // expose oEmbed so pasting a local post builds a card like any other link.
    if (isOwn(url)) return /\/(statuses|@[^/]+)\/[^/?#]+/.test(new URL(url).pathname);
    return true;
  };

  if (content.includes("<a")) {
    for (const tag of content.match(/<a\b[^>]*>/gi) ?? []) {
      const attrs = parseAttributes(tag);
      const rel = attrs.rel ?? "";
      const className = attrs.class ?? "";
      if (/\btag\b/i.test(rel)) continue;
      if (/\b(mention|u-url|h-card|hashtag)\b/i.test(className)) continue;
      const href = attrs.href;
      if (href && acceptable(href)) return href;
    }
  }

  // Plain text fallback (servers that send unlinked URLs).
  const text = content.replace(/<[^>]+>/g, " ");
  for (const match of text.matchAll(URL_PATTERN)) {
    if (acceptable(match[0])) return match[0];
  }
  return null;
}

// ─────────────────────────────────────────
// Metadata parsing
// ─────────────────────────────────────────

interface CardCandidate {
  title: string;
  description: string;
  type: "link" | "photo" | "video" | "rich";
  authorName: string;
  authorUrl: string;
  providerName: string;
  providerUrl: string;
  html: string;
  width: number;
  height: number;
  imageUrl: string | null;
  imageDescription: string;
  embedUrl: string;
  language: string | null;
  publishedAt: string | null;
  canonicalUrl: string | null;
}

interface StructuredData {
  headline?: string;
  description?: string;
  image?: string;
  authorName?: string;
  authorUrl?: string;
  publisherName?: string;
  language?: string;
  datePublished?: string;
  type?: string;
}

const CDATA_JUNK = /^\s*((\/\*\s*<!\[CDATA\[\s*\*\/)|(\/\/\s*<!\[CDATA\[)|(\/\*\s*\]\]>\s*\*\/)|(\/\/\s*\]\]>))\s*$/;

function textOrLanguageTagged(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["@value"] === "string") return obj["@value"];
  }
  return undefined;
}

function firstOfHash(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const found = value.flat().find((item) => item && typeof item === "object" && !Array.isArray(item));
    return (found as Record<string, unknown>) ?? null;
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseJsonLd(html: string): StructuredData | null {
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const cleaned = decodeHtmlEntities(
      match[1].split("\n").filter((line) => !CDATA_JUNK.test(line)).join("\n")
    );
    if (!cleaned.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(cleaned); } catch { continue; }
    const roots: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const root of roots) {
      const obj = firstOfHash(root);
      if (!obj) continue;
      const graph = obj["@graph"];
      const candidates = Array.isArray(graph) ? graph : [obj];
      for (const candidate of candidates) {
        const item = firstOfHash(candidate);
        if (!item) continue;
        const type = item["@type"];
        const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
        if (!types.some((t) => t === "NewsArticle" || t === "WebPage")) continue;
        const author = firstOfHash(item.author);
        const publisher = firstOfHash(item.publisher);
        const image = firstOfHash(item.image);
        const imageUrl = typeof item.image === "string"
          ? item.image
          : (typeof image?.url === "string" ? image.url : undefined);
        const language = item.inLanguage;
        return {
          headline: textOrLanguageTagged(item.headline),
          description: textOrLanguageTagged(item.description),
          image: imageUrl,
          authorName: author ? textOrLanguageTagged(author.name) : undefined,
          authorUrl: typeof author?.url === "string" ? author.url : undefined,
          publisherName: publisher ? textOrLanguageTagged(publisher.name) : undefined,
          language: Array.isArray(language)
            ? textOrLanguageTagged(language[0])
            : textOrLanguageTagged(language),
          datePublished: typeof item.datePublished === "string" ? item.datePublished : undefined,
          type: types[0],
        };
      }
    }
  }
  return null;
}

/** OpenGraph / Twitter Card / JSON-LD fallback (Mastodon LinkDetailsExtractor). */
export function parseOpenGraph(html: string, pageUrl: string): CardCandidate | null {
  const meta = parseMetaTags(html);
  const structured = parseJsonLd(html);

  const playerUrl = httpsUrl(meta.get("twitter:player"), pageUrl);
  const width = positiveInt(meta.get("twitter:player:width"));
  const height = positiveInt(meta.get("twitter:player:height"));

  const title = (structured?.headline
    ?? meta.get("og:title")
    ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? "").trim();
  const description = (structured?.description
    ?? meta.get("og:description")
    ?? meta.get("description")
    ?? "").trim();

  const imageUrl = httpsUrl(structured?.image ?? meta.get("og:image"), pageUrl);

  let canonicalUrl: string | null = null;
  const canonicalHref = parseLinkTags(html).find((tag) => /\bcanonical\b/i.test(tag.rel ?? ""))?.href;
  for (const candidate of [canonicalHref, meta.get("og:url")]) {
    const resolved = httpsUrl(candidate, pageUrl);
    if (!resolved) continue;
    try {
      if (new URL(resolved).hostname === new URL(pageUrl).hostname) { canonicalUrl = resolved; break; }
    } catch { /* ignore */ }
  }

  const type: CardCandidate["type"] = playerUrl ? "video" : "link";
  return {
    title: decodeHtmlEntities(title),
    description: decodeHtmlEntities(description),
    type,
    authorName: decodeHtmlEntities(structured?.authorName ?? meta.get("og:author") ?? meta.get("og:author:username") ?? ""),
    authorUrl: httpsUrl(structured?.authorUrl, pageUrl) ?? "",
    providerName: decodeHtmlEntities(structured?.publisherName ?? meta.get("og:site_name") ?? ""),
    providerUrl: "",
    html: playerUrl ? buildIframe(playerUrl, width, height) : "",
    width,
    height,
    imageUrl,
    imageDescription: decodeHtmlEntities(meta.get("og:image:alt") ?? ""),
    embedUrl: httpsUrl(meta.get("twitter:player:stream"), pageUrl) ?? "",
    language: normalizeLocale(structured?.language ?? meta.get("og:locale") ?? html.match(/<html[^>]*\blang\s*=\s*["']([^"']+)["']/i)?.[1]),
    publishedAt: normalizeDate(structured?.datePublished ?? meta.get("article:published_time")),
    canonicalUrl,
  };
}

/** oEmbed discovery + mapping (Mastodon FetchOEmbedService, JSON only). */
export async function parseOEmbed(
  html: string,
  pageUrl: string,
  userAgents: string[]
): Promise<{ card: CardCandidate; endpointUrl: string } | null> {
  // Mastodon discovers the endpoint by <link type="application/json+oembed">
  // (or text/json+oembed); the rel attribute is not part of the contract.
  const link = parseLinkTags(html).find((tag) => {
    const type = (tag.type ?? "").toLowerCase();
    return type === "application/json+oembed" || type === "text/json+oembed";
  });
  if (!link?.href) return null;

  let endpoint: URL;
  try {
    endpoint = new URL(link.href, pageUrl);
  } catch {
    return null;
  }
  // oEmbed endpoints are https-only, like every outbound request.
  if (endpoint.protocol !== "https:") return null;
  if (!endpoint.searchParams.has("url")) endpoint.searchParams.set("url", pageUrl);
  if (!endpoint.searchParams.has("format")) endpoint.searchParams.set("format", "json");
  const endpointUrl = endpoint.toString();

  const fetched = await fetchWithUserAgents(endpointUrl, {
    userAgents,
    accept: "application/json, text/json;q=0.9, */*;q=0.1",
    timeoutMs: OEMBED_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
  });
  if (!fetched.ok) return null;
  const bytes = await readBoundedBytes(fetched.response, 1024 * 1024);
  if (!bytes) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const version = String(payload.version ?? "");
  const type = String(payload.type ?? "") as CardCandidate["type"];
  if (!version.startsWith("1") || !["link", "photo", "video", "rich"].includes(type)) return null;
  // `rich` embeds (Mastodon statuses, many players) are accepted: only a
  // single https <iframe> is kept (rebuilt by us, scripts dropped) and the
  // rest of the payload still yields a usable card.

  const origin = endpoint.origin;
  const width = positiveInt(payload.width as number | string | undefined);
  const height = positiveInt(payload.height as number | string | undefined);

  let embedHtml = "";
  let embedUrl = "";
  let imageUrl: string | null = null;
  let imageDescription = "";

  if (type === "video" || type === "rich") {
    const rawHtml = typeof payload.html === "string" ? payload.html : "";
    const src = rawHtml.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    const iframeSrc = httpsUrl(src ? decodeHtmlEntities(src) : null, pageUrl);
    if (iframeSrc) embedHtml = buildIframe(iframeSrc, width, height);
    imageUrl = httpsUrl(payload.thumbnail_url as string | undefined, origin);
  } else if (type === "photo") {
    const photo = httpsUrl(payload.url as string | undefined, origin);
    if (!photo) return null;
    imageUrl = photo;
    embedUrl = photo;
  } else {
    imageUrl = httpsUrl(payload.thumbnail_url as string | undefined, origin);
    imageDescription = String(payload.thumbnail_url_alt ?? "");
  }

  return {
    endpointUrl,
    card: {
      title: decodeHtmlEntities(String(payload.title ?? "")).trim(),
      description: "",
      // A `rich` payload without a safe iframe is just a link card.
      type: type === "rich" && !embedHtml ? "link" : type,
      authorName: decodeHtmlEntities(String(payload.author_name ?? "")),
      authorUrl: httpsUrl(payload.author_url as string | undefined, origin) ?? "",
      providerName: decodeHtmlEntities(String(payload.provider_name ?? "")),
      providerUrl: httpsUrl(payload.provider_url as string | undefined, origin) ?? "",
      html: embedHtml,
      width,
      height,
      imageUrl,
      imageDescription,
      embedUrl,
      language: null,
      publishedAt: null,
      canonicalUrl: null,
    },
  };
}

// ─────────────────────────────────────────
// Crawling
// ─────────────────────────────────────────

function isHtmlType(contentType: string): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml" || contentType === "application/xhtml";
}

function plusHours(hours: number, from = Date.now()): string {
  return new Date(from + hours * 3_600_000).toISOString();
}

/** Video id of a YouTube URL (watch, youtu.be, shorts, embed). */
export function youTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
    if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
    if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
    const match = parsed.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * YouTube's watch page (consent wall in the EU) and oEmbed endpoint can be
 * blocked from datacenter IPs; the video id is enough to build a usable card:
 * the CDN thumbnail plus a nocookie embed.
 */
export function applyYouTubeFallback(card: CardCandidate, url: string): void {
  const videoId = youTubeVideoId(url);
  if (!videoId) return;
  if (!card.imageUrl) card.imageUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  if (!card.html) {
    const width = card.width || 480;
    const height = card.height || 270;
    card.width = width;
    card.height = height;
    card.type = "video";
    card.embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}`;
    card.html = buildIframe(card.embedUrl, width, height);
  }
}

type CrawlOutcome =
  | { ok: true; card: CardCandidate; canonicalUrl: string }
  | { ok: false; permanent: boolean; error: string };

async function crawlPage(url: string, userAgents: string[], maxBytes: number): Promise<CrawlOutcome> {
  const fetched = await fetchWithUserAgents(url, {
    userAgents,
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    timeoutMs: PAGE_TIMEOUT_MS,
    maxBytes,
    isAcceptableType: isHtmlType,
  });
  if (!fetched.ok) {
    if (fetched.permanent) console.warn(`[link-preview] Not crawlerable ${url}: ${fetched.error}`);
    return { ok: false, permanent: fetched.permanent, error: fetched.error };
  }
  const contentTypeHeader = fetched.response.headers.get("content-type");
  const bytes = await readBoundedBytes(fetched.response, maxBytes);
  if (!bytes) return { ok: false, permanent: true, error: "page exceeds the size limit" };
  const html = decodeHtml(bytes, contentTypeHeader);

  const oembed = await parseOEmbed(html, url, userAgents);
  const card = oembed?.card ?? parseOpenGraph(html, url);
  if (card) applyYouTubeFallback(card, url);
  if (!card || (!card.title && !card.html)) {
    return { ok: false, permanent: true, error: "no preview metadata" };
  }
  return { ok: true, card, canonicalUrl: card.canonicalUrl ?? url };
}

function toSnapshot(
  card: CardCandidate,
  originalUrl: string,
  imageUrl: string | null
): Record<string, unknown> {
  // Cap remote text: the whole snapshot is stored per status in D1.
  const title = card.title.slice(0, 400);
  const description = card.description.slice(0, 1000);
  return {
    url: originalUrl,
    title,
    description,
    type: card.type,
    author_name: card.authorName,
    author_url: card.authorUrl,
    provider_name: card.providerName,
    provider_url: card.providerUrl,
    html: card.html,
    width: card.width,
    height: card.height,
    image: imageUrl,
    image_description: card.imageDescription.slice(0, 400),
    embed_url: card.embedUrl,
    blurhash: null,
    language: card.language,
    published_at: card.publishedAt,
    authors: card.authorName || card.authorUrl
      ? [{ name: card.authorName, url: card.authorUrl, account: null }]
      : [],
  };
}

async function acquireLock(bindings: LinkPreviewBindings, id: string): Promise<boolean> {
  if (!bindings.KV) return true;
  try {
    const key = `link-preview:lock:${id}`;
    if (await bindings.KV.get(key)) return false;
    await bindings.KV.put(key, "1", { expirationTtl: LOCK_TTL_SECONDS });
    return true;
  } catch {
    return true;
  }
}

/**
 * Crawl the first link of one queued status. Returns true when a card ended up
 * attached to the status.
 */
async function processJob(
  bindings: LinkPreviewBindings,
  limits: NormalizedLinkPreviewLimits,
  object: LocalObject,
  ownDomain: string | null,
  attempts: number
): Promise<boolean> {
  const db = bindings.DB;
  const objectId = object.id;

  if (object.quoteId) {
    await deleteLinkPreviewQueue(db, objectId);
    return false;
  }
  const attachments = await getAttachmentsByObjectId(db, objectId);
  if (attachments.length > 0) {
    await deleteLinkPreviewQueue(db, objectId);
    return false;
  }

  const url = extractFirstLink(object.content, ownDomain);
  if (!url) {
    await deleteLinkPreviewQueue(db, objectId);
    return false;
  }

  // A geolocated status already renders the native map preview: crawling its
  // OpenStreetMap link would show a second, redundant card.
  if (object.locationJson) {
    try {
      if (/(^|\.)openstreetmap\.org$/i.test(new URL(url).hostname)) {
        await deleteLinkPreviewQueue(db, objectId);
        return false;
      }
    } catch { /* not a URL */ }
  }

  // Own status permalinks: a Worker fetching its own hostname times out
  // (HTTP 522), so build the card straight from the database.
  if (ownDomain) {
    try {
      const parsed = new URL(url);
      const match = parsed.hostname === ownDomain
        ? parsed.pathname.match(/^\/(?:statuses|@[^/]+)\/([^/?#]+)/)
        : null;
      if (match) {
        const target = await getObjectById(db, decodeStatusId(match[1], ownDomain));
        if (target) {
          const [author, attachments] = await Promise.all([
            getActorById(db, target.actorId),
            getAttachmentsByObjectId(db, target.id),
          ]);
          const authorName = author?.displayName || author?.username || target.actorId;
          const text = (target.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          const embed = `${parsed.origin}/embed/${encodeStatusId(target.id, target.local)}`;
          const image = author?.avatarCacheUrl ?? author?.avatarUrl ?? attachments[0]?.url ?? null;
          const cardId = await mediaCacheId(url);
          const card: CardCandidate = {
            title: `${authorName}: ${text}`.slice(0, 400),
            description: text.slice(0, 1000),
            type: "rich",
            authorName,
            authorUrl: author ? `${parsed.origin}/@${author.username}` : "",
            providerName: "",
            providerUrl: "",
            html: buildIframe(embed, 400, 320),
            width: 400,
            height: 320,
            imageUrl: image,
            imageDescription: "",
            embedUrl: embed,
            language: target.language,
            publishedAt: target.published,
            canonicalUrl: url,
          };
          await upsertPreviewCard(db, {
            id: cardId, sourceUrl: url, url,
            title: card.title, description: card.description, type: card.type,
            authorName: card.authorName, authorUrl: card.authorUrl,
            providerName: "", providerUrl: "",
            html: card.html, width: card.width, height: card.height,
            imageUrl: image, imageDescription: "", embedUrl: embed,
            language: card.language, publishedAt: card.publishedAt,
          });
          if (limits.mediaCacheEnabled && image) {
            await enqueueMediaCache(db, image, "card", cardId);
            const cache = await getMediaCacheStatusBySourceUrl(db, image);
            if (cache?.status === "pending") return false;
          }
          const stored = await getPreviewCardBySourceUrl(db, url);
          const servedImage = stored?.imageCacheUrl ?? stored?.imageUrl ?? image;
          const snapshot = JSON.stringify(toSnapshot(card, url, servedImage));
          await linkObjectPreviewCard(db, objectId, cardId, snapshot);
          await updateObjectCardSnapshots(db, cardId, snapshot);
          await deleteLinkPreviewQueue(db, objectId);
          return true;
        }
      }
    } catch { /* fall through to the network crawl */ }
  }

  const existing = await getPreviewCardBySourceUrl(db, url);

  if (existing) {
    const fetchedMs = Date.parse(existing.fetchedAt ?? "");
    const fresh = Number.isFinite(fetchedMs) && Date.now() - fetchedMs < limits.days * 86_400_000;
    if (existing.status === "ready" && fresh) {
      // The image must be served from R2: keep waiting (job stays queued,
      // attempts untouched) instead of emitting the origin URL.
      if (limits.mediaCacheEnabled && existing.imageUrl && !existing.imageCacheUrl) {
        const cache = await getMediaCacheStatusBySourceUrl(db, existing.imageUrl);
        if (cache?.status === "pending") return false;
      }
      const snapshot = toSnapshot(
        {
          title: existing.title, description: existing.description, type: existing.type,
          authorName: existing.authorName, authorUrl: existing.authorUrl,
          providerName: existing.providerName, providerUrl: existing.providerUrl,
          html: existing.html, width: existing.width, height: existing.height,
          imageUrl: existing.imageUrl, imageDescription: existing.imageDescription,
          embedUrl: existing.embedUrl, language: existing.language,
          publishedAt: existing.publishedAt, canonicalUrl: existing.url,
        },
        url,
        existing.imageCacheUrl ?? existing.imageUrl
      );
      await linkObjectPreviewCard(db, objectId, existing.id, JSON.stringify(snapshot));
      await deleteLinkPreviewQueue(db, objectId);
      return true;
    }
    if (existing.status === "failed" && Date.parse(existing.nextAttemptAt) > Date.now()) {
      // Negative cache: don't hit the origin again yet.
      await deleteLinkPreviewQueue(db, objectId);
      return false;
    }
  }

  const cardId = await mediaCacheId(url);
  const validation = validateOutboundUrl(url);
  if (!validation.valid) {
    await markPreviewCardFailed(db, cardId, url, validation.reason ?? "blocked", plusHours(NEGATIVE_CACHE_HOURS));
    await deleteLinkPreviewQueue(db, objectId);
    return false;
  }
  if (!(await acquireLock(bindings, cardId))) {
    // Another worker is already crawling this URL; retry next tick.
    return false;
  }

  let outcome: CrawlOutcome;
  try {
    outcome = await crawlPage(url, limits.userAgents, limits.maxBytes);
  } catch (err) {
    console.warn(`[link-preview] Crawl failed for ${url}: ${String(err).slice(0, 200)}`);
    outcome = { ok: false, permanent: false, error: String(err) };
  }

  if (!outcome.ok) {
    if (existing?.status === "ready") {
      // Keep serving the old card; stop retrying this job.
      await deleteLinkPreviewQueue(db, objectId);
      return false;
    }
    // Permanent (404, non-HTML, no metadata) or out of attempts: negative
    // cache the URL so every status linking to it skips the origin. Transient
    // failures back off (1h/6h/24h) and the queue retries.
    if (outcome.permanent || attempts + 1 >= MAX_ATTEMPTS) {
      await markPreviewCardFailed(db, cardId, url, outcome.error, plusHours(NEGATIVE_CACHE_HOURS));
      await deleteLinkPreviewQueue(db, objectId);
    } else {
      await markLinkPreviewFailed(
        db,
        objectId,
        outcome.error,
        plusHours(RETRY_HOURS[Math.min(attempts, RETRY_HOURS.length - 1)])
      );
    }
    return false;
  }

  const input: PreviewCardInput = {
    id: cardId,
    sourceUrl: url,
    url: outcome.canonicalUrl,
    title: outcome.card.title,
    description: outcome.card.description,
    type: outcome.card.type,
    authorName: outcome.card.authorName,
    authorUrl: outcome.card.authorUrl,
    providerName: outcome.card.providerName,
    providerUrl: outcome.card.providerUrl,
    html: outcome.card.html,
    width: outcome.card.width,
    height: outcome.card.height,
    imageUrl: outcome.card.imageUrl,
    imageDescription: outcome.card.imageDescription,
    embedUrl: outcome.card.embedUrl,
    language: outcome.card.language,
    publishedAt: outcome.card.publishedAt,
  };
  await upsertPreviewCard(db, input);

  if (limits.mediaCacheEnabled && outcome.card.imageUrl) {
    try {
      // Reuses the media-cache fetch client (same user agents); the fast path
      // applies an already-cached copy to the card snapshot immediately.
      await enqueueMediaCache(db, outcome.card.imageUrl, "card", cardId);
      const cache = await getMediaCacheStatusBySourceUrl(db, outcome.card.imageUrl);
      if (cache?.status === "pending") {
        // Wait for R2 (or a permanent failure) before attaching the card: the
        // job stays queued and no attempt is consumed, so once the image is
        // ready the card is attached and broadcast with the cached URL.
        return false;
      }
    } catch { /* cache is best-effort */ }
  }

  const stored = await getPreviewCardBySourceUrl(db, url);
  // Fall back to the origin image whenever the cached copy is not ready
  // (pending entries already returned above): a blocked/errored cache must not
  // leave the card image-less.
  const servedImage = stored?.imageCacheUrl ?? stored?.imageUrl ?? outcome.card.imageUrl;
  const snapshot = JSON.stringify(toSnapshot(outcome.card, url, servedImage));
  await linkObjectPreviewCard(db, objectId, cardId, snapshot);
  await updateObjectCardSnapshots(db, cardId, snapshot);
  await deleteLinkPreviewQueue(db, objectId);
  return true;
}

export interface ProcessLinkPreviewOptions {
  /** Max jobs per run (defaults to `LINK_PREVIEW_FETCH_BATCH`). */
  limit?: number;
  /** Wall-clock budget for the whole batch. */
  budgetMs?: number;
  /**
   * Called with the object id whenever a card ends up attached, so the caller
   * can broadcast a `status.update` (the status was delivered before the card
   * existed and clients would otherwise need a manual refresh).
   */
  onAttached?: (objectId: string) => Promise<void> | void;
}

/**
 * Cron stage: crawl a bounded batch of queued statuses. Failures back off
 * (1h/6h/24h) and permanently bad URLs are negative cached for a week.
 */
export async function processLinkPreviewQueue(
  bindings: LinkPreviewBindings,
  rawLimits: LinkPreviewLimits,
  ownDomain: string | null,
  options: ProcessLinkPreviewOptions = {}
): Promise<number> {
  const limits = normalizeLimits(rawLimits);
  if (!limits.enabled) return 0;
  const budgetMs = options.budgetMs ?? MAX_QUEUE_BUDGET_MS;

  const jobs = await listLinkPreviewQueue(bindings.DB, options.limit ?? limits.fetchBatch);
  const deadline = Date.now() + budgetMs;
  let processed = 0;

  for (const job of jobs) {
    if (Date.now() >= deadline) break;
    try {
      const object = await getObjectById(bindings.DB, job.objectId);
      if (!object) {
        await deleteLinkPreviewQueue(bindings.DB, job.objectId);
        continue;
      }
      if (await processJob(bindings, limits, object, ownDomain, job.attempts)) {
        processed += 1;
        if (options.onAttached) {
          try {
            await options.onAttached(object.id);
          } catch (err) {
            console.error(`[link-preview] Attach broadcast failed for ${object.id}`, err);
          }
        }
      }
    } catch (err) {
      console.error(`[link-preview] Job failed for ${job.objectId}`, err);
      const attempts = job.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await deleteLinkPreviewQueue(bindings.DB, job.objectId).catch(() => {});
      } else {
        await markLinkPreviewFailed(
          bindings.DB,
          job.objectId,
          String(err),
          plusHours(RETRY_HOURS[Math.min(attempts - 1, RETRY_HOURS.length - 1)])
        ).catch(() => {});
      }
    }
  }

  try {
    await cleanupOrphanPreviewCards(bindings.DB, 20);
  } catch { /* best-effort */ }

  return processed;
}

/**
 * Queue a status for link crawling when it is worth it: no media, no quote,
 * and at least one URL-looking token in the content. Safe to call on old
 * databases (the queue table may not exist yet).
 */
export async function maybeEnqueueLinkPreview(
  db: D1Database,
  object: { id: string; content: string | null; quoteId: string | null; hasAttachments: boolean }
): Promise<void> {
  if (object.hasAttachments || object.quoteId) return;
  if (!object.content || !/https?:\/\//i.test(object.content)) return;
  try {
    await enqueueLinkPreview(db, object.id);
  } catch (err) {
    console.warn(`[link-preview] Could not enqueue ${object.id}: ${String(err).slice(0, 160)}`);
  }
}
