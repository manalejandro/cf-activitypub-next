"use client";

import { useState, useEffect, useMemo, useCallback, useRef, memo, type ComponentProps } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Lightbox, embeddableUrl } from "./Lightbox";
import { youTubeEmbedUrl } from "@/lib/youtube";
import { previewCardFor } from "@/lib/location";
import { InteractionList } from "./InteractionList";
import { MemoRichText } from "./RichText";
import { renderEmojiInHtml } from "@/lib/emoji";
import { DisplayName } from "@/components/DisplayName";
import { Avatar } from "@/components/Avatar";
import { usePreferences } from "@/lib/preferences-client";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { APTypeBlock, TypeBadge, type APMeta } from "./APTypeBlock";
import { Icon } from "./Icon";
import { LicenseBadge } from "./LicenseBadge";
import { useLicenseInfo } from "@/lib/license-client";
import LocationPreview from "./LocationPreview";
import { MediaPlayer } from "./MediaPlayer";
import { MAX_LANG_CODE_CHARS } from "@/lib/constants";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
  emojis?: EmojiData[];
  verified?: boolean;
}

export interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
  blurhash?: string | null;
  sensitive?: boolean;
}

export interface LinkPreviewCardData {
  url: string;
  title: string;
  description: string;
  type: "link" | "photo" | "video" | "rich";
  author_name: string;
  author_url: string;
  provider_name: string;
  provider_url: string;
  html: string;
  width: number;
  height: number;
  image: string | null;
  image_description: string;
  embed_url: string;
  blurhash?: string | null;
  language?: string | null;
  published_at?: string | null;
}

export interface PollOption { title: string; votes_count: number | null }
export interface Poll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number | null;
  voted: boolean;
  own_votes: number[];
  options: PollOption[];
}

export interface EmojiData {
  shortcode: string;
  url: string;
  static_url: string;
}

export interface Status {
  id: string;
  content: string;
  created_at: string;
  edited_at?: string | null;
  in_reply_to_id?: string | null;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  bookmarked?: boolean;
  pinned?: boolean;
  muted?: boolean;
  media_attachments: MediaAttachment[];
  sensitive: boolean;
  spoiler_text: string;
  language?: string | null;
  visibility?: string;
  poll: Poll | null;
  card?: LinkPreviewCardData | null;
  location?: { name: string | null; latitude: number; longitude: number } | null;
  /** FEP-6757 license URI of the status (absent = all rights reserved). */
  license_url?: string | null;
  emojis?: EmojiData[];
  tags?: { name: string; url: string }[];
  ap_type?: string | null;
  quote?: Status | null;
  quotes_count?: number;
  ap_meta?: APMeta | null;
  filtered?: { filter: { id: string; title: string; filter_action: "warn" | "hide" | "blur"; context?: string[] }; keyword_matches?: string[]; status_matches?: string[] }[];
  /** Set on a boost wrapper: the boosted status (Mastodon's `reblog`). */
  reblog?: Status | null;
}

export interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  verified?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatTime(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString();
}

// ─── AvatarBubble ─────────────────────────────────────────────────────────────

export function AvatarBubble({ account, size = 42 }: { account: Account; size?: number }) {
  const [err, setErr] = useState(false);
  const fallback = (account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase();
  if (!err && account.avatar) {
    return (
      <Image
        src={account.avatar}
        alt={account.display_name}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
        onError={() => setErr(true)}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: "50%",
        background: "var(--accent-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.45,
        fontWeight: 700,
        color: "var(--accent)",
      }}
    >
      {fallback}
    </div>
  );
}

// ─── MediaGrid ────────────────────────────────────────────────────────────────

export function MediaGrid({ attachments, sensitive, defaultRevealed = false }: { attachments: MediaAttachment[]; sensitive?: boolean; defaultRevealed?: boolean }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(defaultRevealed);
  const closeLb = useCallback(() => setLbIdx(null), []);
  const { t } = useLocale();
  if (!attachments.length) return null;
  // Blur by default when the status is sensitive or any attachment is sensitive
  // (Mastodon behaviour), until the user explicitly reveals the media.
  const hasSensitive = sensitive === true || attachments.some((a) => a.sensitive);
  const blurred = !revealed && hasSensitive;
  const gridCols = attachments.length === 1 ? 1 : attachments.length === 2 ? 2 : attachments.length <= 3 ? 3 : 2;
  const revealBtn = (
    <button
      type="button"
      onClick={() => setRevealed(true)}
      aria-label={t.media_reveal}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 2,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.5rem",
        background: "rgba(0,0,0,0.55)",
        color: "#fff",
        border: "none",
        cursor: "pointer",
        fontSize: "0.85rem",
        fontWeight: 600,
      }}
    >
      <Icon name="eye-slash" size="1.4rem" color="#fff" />
      <span>{t.media_sensitive_label}</span>
    </button>
  );
  const hideBtn = (
    <button
      type="button"
      onClick={() => setRevealed(false)}
      aria-label={t.media_hide}
      title={t.media_hide}
      style={{
        position: "absolute",
        top: "0.4rem",
        right: "0.4rem",
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        gap: "0.3rem",
        background: "rgba(0,0,0,0.55)",
        color: "#fff",
        border: "none",
        borderRadius: "var(--radius-sm)",
        padding: "0.25rem 0.5rem",
        cursor: "pointer",
        fontSize: "0.72rem",
        fontWeight: 600,
      }}
    >
      <Icon name="eye" size="0.9rem" color="#fff" /> {t.media_hide}
    </button>
  );
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
          gap: "0.25rem",
          marginTop: "0.75rem",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {attachments.map((att, i) => {
          if (att.type === "image") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => { if (!blurred) setLbIdx(i); }}
                aria-label={att.description ?? t.action_view_media}
                title={att.description ?? undefined}
                style={{
                  display: "block",
                  position: "relative",
                  aspectRatio: attachments.length === 1 ? "16/9" : "1/1",
                  overflow: "hidden",
                  border: "none",
                  padding: 0,
                  cursor: blurred ? "default" : "zoom-in",
                  background: "none",
                }}
              >
                <Image
                  src={att.preview_url ?? att.url}
                  alt={att.description ?? ""}
                  fill
                  sizes="(max-width: 768px) 100vw, 600px"
                  style={{ objectFit: "cover", filter: blurred ? "blur(12px)" : undefined }}
                />
              </button>
            );
          }
          if (att.type === "video" || att.type === "gifv") {
            const isGifv = att.type === "gifv";
            return (
              <div
                key={att.id}
                style={{
                  position: "relative",
                  aspectRatio: isGifv && attachments.length > 1 ? "1/1" : "16/9",
                  overflow: "hidden",
                  background: "#000",
                }}
              >
                <div style={{ position: "absolute", inset: 0, filter: blurred ? "blur(12px)" : undefined }}>
                  <MediaPlayer
                    src={att.url}
                    poster={att.preview_url ?? att.url}
                    description={att.description}
                    kind={isGifv ? "gifv" : "video"}
                    variant="inline"
                    autoPlay={isGifv}
                    loop={isGifv}
                    muted={isGifv}
                  />
                </div>
                {isGifv ? (
                  <button
                    type="button"
                    onClick={() => { if (!blurred) setLbIdx(i); }}
                    aria-label={att.description ?? t.action_view_media}
                    title={att.description ?? t.action_view_media}
                    style={{ position: "absolute", inset: 0, zIndex: 1, background: "transparent", border: "none", padding: 0, cursor: blurred ? "default" : "zoom-in" }}
                  />
                ) : blurred ? null : (
                  <button
                    type="button"
                    onClick={() => setLbIdx(i)}
                    aria-label={t.media_expand}
                    title={t.media_expand}
                    style={{
                      position: "absolute", top: "0.4rem", right: "0.4rem", zIndex: 3,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      width: 30, height: 30, borderRadius: "var(--radius-sm)", border: "none",
                      background: "rgba(0,0,0,0.55)", color: "#fff", cursor: "pointer",
                    }}
                  >
                    <Icon name="arrows-alt" color="#fff" />
                  </button>
                )}
              </div>
            );
          }
          if (att.type === "audio") {
            return (
              <div
                key={att.id}
                style={{
                  gridColumn: attachments.length === 1 ? "auto" : "1 / -1",
                  filter: blurred ? "blur(12px)" : undefined,
                }}
              >
                <MediaPlayer src={att.url} kind="audio" variant="inline" description={att.description} />
              </div>
            );
          }
          return null;
        })}
        {blurred && revealBtn}
        {!blurred && hasSensitive && hideBtn}
      </div>
      {!blurred && lbIdx !== null && (
        <Lightbox
          media={attachments.map((a) => ({ url: a.url, preview_url: a.preview_url, description: a.description, type: a.type }))}
          index={lbIdx}
          onClose={closeLb}
          onNav={setLbIdx}
        />
      )}
    </>
  );
}

// ─── PollView ─────────────────────────────────────────────────────────────────

export function PollView({ poll: initialPoll }: { poll: Poll }) {
  const { t } = useLocale();
  const [poll, setPoll] = useState<Poll>(initialPoll);
  const [voting, setVoting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const token = getToken();
  const total = poll.votes_count > 0 ? poll.votes_count : 1;
  const showResults = poll.voted || poll.expired;
  const canVote = !poll.voted && !poll.expired && !!token;

  async function vote() {
    if (!token || voting || selected.length === 0) return;
    setVoting(true);
    try {
      const res = await fetch(`/api/v1/polls/${poll.id}/votes`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choices: selected }),
      });
      if (res.ok) setPoll(await res.json() as Poll);
    } finally { setVoting(false); }
  }

  return (
    <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      {poll.options.map((opt, i) => {
        const pct = showResults && opt.votes_count != null ? Math.round((opt.votes_count / total) * 100) : 0;
        const isOwn = poll.own_votes.includes(i) || selected.includes(i);
        return (
          <div key={i}>
            {showResults ? (
              <div style={{ position: "relative", borderRadius: "var(--radius-sm)", overflow: "hidden", background: "var(--bg-elevated)", padding: "0.35rem 0.75rem" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: isOwn ? "var(--accent-bg)" : "color-mix(in srgb, var(--accent-bg) 40%, transparent)", transition: "width 0.4s" }} />
                <div style={{ position: "relative", display: "flex", justifyContent: "space-between", fontSize: "0.875rem" }}>
                  <span style={{ fontWeight: isOwn ? 600 : 400 }}>{opt.title}{isOwn && <> <Icon name="check" size="0.85rem" color="var(--accent)" /></>}</span>
                  <span style={{ color: "var(--text-muted)" }}>{pct}%</span>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => poll.multiple
                  ? setSelected((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i])
                  : setSelected([i])
                }
                style={{ width: "100%", textAlign: "left", padding: "0.35rem 0.75rem", border: `1.5px solid ${selected.includes(i) ? "var(--accent)" : "var(--border)"}`, borderRadius: "var(--radius-sm)", background: selected.includes(i) ? "var(--accent-bg)" : "transparent", cursor: "pointer", fontSize: "0.875rem", color: "var(--text)" }}
              >
                {opt.title}
              </button>
            )}
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
        {canVote && (
          <button type="button" className="btn btn-primary btn-sm" disabled={selected.length === 0 || voting} onClick={() => void vote()}>
            {voting ? "…" : t.poll_vote}
          </button>
        )}
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {poll.votes_count} {poll.votes_count === 1 ? t.poll_votes_1 : t.poll_votes_n}
          {poll.expires_at && <> · {poll.expired ? t.poll_closed : t.poll_closes.replace("{date}", new Date(poll.expires_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}</>}
          {poll.multiple && ` · ${t.poll_multiple}`}
        </span>
      </div>
    </div>
  );
}

// ─── QuoteInline ────────────────────────────────────────────────────────────
// Compact rendering of a quoted post, shown inline inside the quoting status.

export function QuoteInline({ quote }: { quote: Status }) {
  const { t } = useLocale();
  const href = `/statuses/${encodeURIComponent(quote.id)}`;
  const quotedContent = renderEmojiInHtml(quote.content ?? "", quote.emojis ?? []);
  return (
    <Link
      href={href}
      style={{
        display: "block",
        textDecoration: "none",
        color: "inherit",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "0.625rem 0.75rem",
        marginTop: "0.6rem",
        background: "var(--bg-elevated)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.25rem" }}>
        <Avatar avatar={quote.account.avatar} name={quote.account.display_name || quote.account.username} size={20} />
        <span style={{ fontWeight: 600, fontSize: "0.82rem" }}>
          <DisplayName name={quote.account.display_name || quote.account.username} emojis={quote.account.emojis} />
          {quote.account.verified && <Icon name="check" color="var(--success)" size="0.7rem" />}
        </span>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>@{quote.account.acct}</span>
      </div>
      <div
        className="status-content"
        style={{
          fontSize: "0.8rem",
          lineHeight: 1.5,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 4,
          WebkitBoxOrient: "vertical",
          color: "var(--text-secondary)",
        }}
      >
        {quote.spoiler_text ? (
          <span>{t.cw_show}: {quote.spoiler_text}</span>
        ) : (
          <MemoRichText html={quotedContent} />
        )}
      </div>
    </Link>
  );
}

// ─── StatusCard ───────────────────────────────────────────────────────────────

/**
 * Embeddable player URL for a preview card, or null when the card is not a
 * provider player. In-place playback is only for players: YouTube always
 * (whatever `type` the snapshot carries — older cards were stored as
 * "link"/"rich") plus cards the crawler typed as `video`. `rich` embeds are
 * pages, not media (WordPress post embeds, Mastodon status embeds): framing them
 * in the 16/9 lightbox reads as an empty box, so they keep the plain link card.
 */
export function playableCardEmbedUrl(card: {
  type?: string | null;
  embed_url?: string | null;
  url?: string | null;
}): string | null {
  const youTube = youTubeEmbedUrl(card.embed_url, card.url);
  if (youTube) return youTube;
  if (card.type !== "video") return null;
  return embeddableUrl(card.embed_url, card.url);
}

function LinkPreview({ card, sensitive }: { card: LinkPreviewCardData; sensitive: boolean }) {
  const { t } = useLocale();
  const [revealed, setRevealed] = useState(false);
  const [embedOpen, setEmbedOpen] = useState(false);
  const blurred = sensitive && !revealed;
  const host = (() => {
    try { return new URL(card.url).hostname; } catch { return card.url; }
  })();
  const title = card.title || host;
  const embedUrl = playableCardEmbedUrl(card);
  const playButton = (
    <span
      style={{
        background: "rgba(0,0,0,0.6)",
        borderRadius: "50%",
        width: "2.6rem",
        height: "2.6rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name="play" size="1.1rem" color="#fff" />
    </span>
  );

  return (
    <div
      style={{
        marginTop: "0.6rem",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-elevated)",
        overflow: "hidden",
      }}
    >
      {card.image && (
        <div style={{ position: "relative", width: "100%", aspectRatio: "16/9", background: "var(--bg-overlay)" }}>
          <Image
            src={card.image}
            alt={card.image_description || title}
            fill
            sizes="(max-width: 768px) 100vw, 600px"
            style={{ objectFit: "cover", filter: blurred ? "blur(12px)" : undefined }}
          />
          {!blurred && embedUrl && (
            <button
              type="button"
              onClick={() => setEmbedOpen(true)}
              aria-label={t.media_play}
              title={t.media_play}
              style={{
                position: "absolute", inset: 0, zIndex: 2, display: "flex",
                alignItems: "center", justifyContent: "center", border: "none",
                background: "transparent", cursor: "pointer",
              }}
            >
              {playButton}
            </button>
          )}
          {!blurred && !embedUrl && (
            <a
              href={card.url}
              target="_blank"
              rel="nofollow noopener noreferrer"
              aria-label={title}
              style={{ position: "absolute", inset: 0, zIndex: 1 }}
            />
          )}
          {!blurred && !embedUrl && card.type === "video" && (
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              {playButton}
            </span>
          )}
          {blurred && (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              aria-label={t.media_reveal}
              style={{ position: "absolute", inset: 0, zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.4rem", background: "rgba(0,0,0,0.55)", color: "#fff", border: "none", cursor: "pointer", fontSize: "0.8rem", fontWeight: 600 }}
            >
              <Icon name="eye-slash" size="1.3rem" color="#fff" />
              <span>{t.media_sensitive_label}</span>
            </button>
          )}
        </div>
      )}
      {!card.image && embedUrl && !blurred && (
        <button
          type="button"
          onClick={() => setEmbedOpen(true)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: "0.4rem",
            width: "100%", padding: "0.75rem", border: "none", background: "transparent",
            color: "var(--accent)", cursor: "pointer", fontSize: "0.85rem", fontWeight: 600,
          }}
        >
          {playButton} {t.media_play}
        </button>
      )}
      <a
        href={card.url}
        target="_blank"
        rel="nofollow noopener noreferrer"
        style={{ display: "flex", flexDirection: "column", gap: "0.15rem", padding: "0.6rem 0.75rem", textDecoration: "none", color: "inherit" }}
      >
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.03em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {card.provider_name || host}
        </span>
        <span style={{ fontWeight: 600, fontSize: "0.9rem", lineHeight: 1.35 }}>{title}</span>
        {card.description && (
          <span style={{ fontSize: "0.82rem", color: "var(--text-muted)", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {card.description}
          </span>
        )}
      </a>
      {embedOpen && embedUrl && (
        <Lightbox
          media={[{ url: card.url, preview_url: card.image, description: title, type: "video", embed_url: embedUrl }]}
          index={0}
          onClose={() => setEmbedOpen(false)}
          onNav={() => {}}
        />
      )}
    </div>
  );
}

function StatusCardInner({
  status,
  isFocal = false,
  onFav,
  onReblog,
  onReply,
  onQuote,
  me,
  onDelete,
  onEdit,
  onPin,
  onBookmarkChange,
  forceDelete = false,
  hideActions = false,
  permalink = true,
  filterContext = "public",
}: {
  status: Status;
  isFocal?: boolean;
  onFav: (s: Status) => void;
  onReblog: (s: Status) => void;
  onReply: (s: Status) => void;
  onQuote?: (s: Status) => void;
  me?: Me | null;
  onDelete?: (s: Status) => void;
  onEdit?: (s: Status) => void;
  onPin?: (s: Status) => void;
  /** Called with the updated status after a bookmark/unbookmark succeeds. */
  onBookmarkChange?: (s: Status) => void;
  forceDelete?: boolean;
  hideActions?: boolean;
  /** Render the timestamp as plain text: E2EE cards have no status page behind
   *  them (only public envelopes are stored as statuses). */
  permalink?: boolean;
  filterContext?: "home" | "notifications" | "public" | "thread" | "account";
}) {
  const prefs = usePreferences();
  // FEP-6757: resolve the status license (catalogue, origin instance, or just
  // the URI so the badge shows the letters of its id).
  const licenseInfo = useLicenseInfo(status.license_url);
  const [cwExpanded, setCwExpanded] = useState(prefs["reading:expand:spoilers"] === true);
  // ── Server-side filter results (Mastodon v2 filters) ────────────────────
  // Only results whose filter applies to the current view context count.
  const matchedFilters = (status.filtered ?? []).filter((fr) =>
    (fr.filter.context ?? []).includes(filterContext)
  );
  const hideByFilter = matchedFilters.some((fr) => fr.filter.filter_action === "hide");
  const warnByFilter = matchedFilters.some((fr) => fr.filter.filter_action === "warn");
  const blurByFilter = matchedFilters.some((fr) => fr.filter.filter_action === "blur");
  const filterTitles = matchedFilters.map((fr) => fr.filter.title);
  const [filterRevealed, setFilterRevealed] = useState(false);
  const renderedContent = useMemo(
    () => renderEmojiInHtml(status.content, status.emojis ?? []),
    [status.content, status.emojis]
  );

  // Optimistic local state – updated instantly on click, then synced from prop
  const [favourited, setFavourited] = useState(status.favourited);
  const [reblogged, setReblogged] = useState(status.reblogged);
  const [bookmarked, setBookmarked] = useState(status.bookmarked ?? false);
  const [pinned, setPinned] = useState(status.pinned ?? false);
  const [muted, setMuted] = useState(status.muted ?? false);
  const [favouritesCount, setFavouritesCount] = useState(status.favourites_count);
  const [reblogsCount, setReblogsCount] = useState(status.reblogs_count);

  const token = getToken();
  const router = useRouter();
  const [interactionList, setInteractionList] = useState<{ type: "favourited_by" | "reblogged_by"; url: string } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translatedContent, setTranslatedContent] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { t, locale } = useLocale();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleTranslate() {
    if (translatedContent) {
      setShowTranslation((v) => !v);
      return;
    }
    if (!token) return;
    setTranslating(true);
    try {
      const targetLang = navigator.language.slice(0, MAX_LANG_CODE_CHARS) || "en";
      const res = await fetch(`/api/v1/statuses/${encodeURIComponent(status.id)}/translate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ lang: targetLang }),
      });
      if (res.ok) {
        const data = await res.json() as { content?: string };
        if (data.content) {
          setTranslatedContent(data.content);
          setShowTranslation(true);
        }
      }
    } catch {
      // silently fail
    } finally {
      setTranslating(false);
    }
  }

  // Sync when the parent replaces the status (different id or parent-driven toggle)
  // React-recommended "adjusting state during render" pattern, keyed on the
  // values we keep as optimistic local state.
  const [prevSync, setPrevSync] = useState({
    id: status.id,
    favourited: status.favourited,
    favouritesCount: status.favourites_count,
    reblogged: status.reblogged,
    reblogsCount: status.reblogs_count,
    bookmarked: status.bookmarked ?? false,
    pinned: status.pinned ?? false,
    muted: status.muted ?? false,
  });
  if (
    prevSync.id !== status.id ||
    prevSync.favourited !== status.favourited ||
    prevSync.favouritesCount !== status.favourites_count ||
    prevSync.reblogged !== status.reblogged ||
    prevSync.reblogsCount !== status.reblogs_count ||
    prevSync.bookmarked !== (status.bookmarked ?? false) ||
    prevSync.pinned !== (status.pinned ?? false) ||
    prevSync.muted !== (status.muted ?? false)
  ) {
    setPrevSync({
      id: status.id,
      favourited: status.favourited,
      favouritesCount: status.favourites_count,
      reblogged: status.reblogged,
      reblogsCount: status.reblogs_count,
      bookmarked: status.bookmarked ?? false,
      pinned: status.pinned ?? false,
      muted: status.muted ?? false,
    });
    setFavourited(status.favourited);
    setReblogged(status.reblogged);
    setBookmarked(status.bookmarked ?? false);
    setPinned(status.pinned ?? false);
    setMuted(status.muted ?? false);
    setFavouritesCount(status.favourites_count);
    setReblogsCount(status.reblogs_count);
  }

  const isRemote = status.account.acct.includes("@");
  const profileHref = isRemote
    ? `/users/remote?url=${encodeURIComponent(status.account.id)}`
    : `/users/${status.account.username}`;
  const threadHref = `/statuses/${encodeURIComponent(status.id)}`;
  const showContent = !status.spoiler_text || cwExpanded;
  // A geolocated status already renders the map: no duplicate location card.
  const previewCard = previewCardFor(status.card, status.location);

  const visibilityInfo = (() => {
    switch (status.visibility) {
      case "unlisted": return { icon: "unlock", label: t.vis_unlisted };
      case "private": return { icon: "lock", label: t.vis_followers };
      case "direct": return { icon: "envelope", label: t.vis_direct };
      default: return { icon: "globe", label: t.vis_public };
    }
  })();

  async function handleFav() {
    if (!token) return;
    const wasFav = favourited;
    setFavourited(!wasFav);
    setFavouritesCount((c) => c + (wasFav ? -1 : 1));
    const path = wasFav ? "unfavourite" : "favourite";
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(status.id)}/${path}`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) {
      const updated = await res.json() as Status;
      setFavourited(updated.favourited);
      setFavouritesCount(updated.favourites_count);
      onFav(updated);
    } else {
      setFavourited(wasFav);
      setFavouritesCount((c) => c + (wasFav ? 1 : -1));
    }
  }

  async function handleReblog() {
    if (!token) return;
    const wasReblogged = reblogged;
    setReblogged(!wasReblogged);
    setReblogsCount((c) => c + (wasReblogged ? -1 : 1));
    const path = wasReblogged ? "unreblog" : "reblog";
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(status.id)}/${path}`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) {
      const updated = await res.json() as Status;
      setReblogged(updated.reblogged);
      setReblogsCount(updated.reblogs_count);
      onReblog(updated);
    } else {
      setReblogged(wasReblogged);
      setReblogsCount((c) => c + (wasReblogged ? 1 : -1));
    }
  }

  async function handleBookmark() {
    if (!token) return;
    const wasBookmarked = bookmarked;
    setBookmarked(!wasBookmarked);
    const path = wasBookmarked ? "unbookmark" : "bookmark";
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(status.id)}/${path}`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) {
      const updated = await res.json() as Status;
      setBookmarked(updated.bookmarked ?? !wasBookmarked);
      onBookmarkChange?.(updated);
    } else {
      setBookmarked(wasBookmarked);
    }
  }

  async function handlePin() {
    if (!token) return;
    const wasPinned = pinned;
    setPinned(!wasPinned);
    const path = wasPinned ? "unpin" : "pin";
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(status.id)}/${path}`, {
      method: "POST",
      credentials: "include",
    });
    if (res.ok) {
      const updated = await res.json() as Status;
      setPinned(updated.pinned ?? !wasPinned);
      onPin?.(updated);
    } else {
      setPinned(wasPinned);
    }
  }

  async function handleMute() {
    if (!token) return;
    const wasMuted = muted;
    setMuted(!wasMuted);
    const path = wasMuted ? "unmute" : "mute";
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(status.id)}/${path}`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) setMuted(wasMuted);
  }

  // ── Filters: hide entirely, or replace with a reveal banner ─────────────
  if (hideByFilter) return null;
  if (warnByFilter && !filterRevealed) {
    return (
      <div
        className="flex items-center justify-between gap-3"
        style={{
          padding: "0.875rem 1rem",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.85rem",
          color: "var(--text-secondary)",
        }}
      >
        <span className="flex items-center gap-2" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <Icon name="eye-slash" size="1rem" />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {t.filtered_by}: {filterTitles.join(", ")}
          </span>
        </span>
        <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0, fontSize: "0.78rem" }} onClick={() => setFilterRevealed(true)}>
          {t.filtered_show}
        </button>
      </div>
    );
  }

  return (
    <article
      style={{
        display: "flex",
        gap: "0.875rem",
        padding: "1rem",
        borderBottom: "1px solid var(--border)",
        background: isFocal ? "var(--bg-elevated)" : undefined,
      }}
    >
      <Link href={profileHref}>
        <AvatarBubble account={status.account} size={isFocal ? 48 : 42} />
      </Link>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-baseline gap-2" style={{ marginBottom: "0.3rem", flexWrap: "wrap" }}>
          <Link href={profileHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
            <DisplayName name={status.account.display_name || status.account.username} emojis={status.account.emojis} />
            {status.account.verified && (
              <span title={t.verified_badge} style={{ marginLeft: "0.25rem", verticalAlign: "middle" }}><Icon name="check" color="var(--success)" size="0.8rem" /></span>
            )}
          </Link>
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{status.account.acct}</span>
          {pinned && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "0.25rem", display: "inline-flex" }}><Icon name="thumb-tack" size="0.7rem" /></span>}
          <span
            title={visibilityInfo.label}
            style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "auto", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <Icon name={visibilityInfo.icon} size="0.7rem" /> <span className="hidden md:inline">{visibilityInfo.label}</span>
          </span>
          {permalink ? (
            <Link href={threadHref} title={new Date(status.created_at).toLocaleString()} aria-label={`${new Date(status.created_at).toLocaleString()}, ${t.action_reply}`} style={{ fontSize: "0.78rem", color: "var(--text-muted)", textDecoration: "none" }}>
              {formatTime(status.created_at)}
            </Link>
          ) : (
            <span title={new Date(status.created_at).toLocaleString()} style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
              {formatTime(status.created_at)}
            </span>
          )}
        </div>
        <TypeBadge apType={status.ap_type} />
        {status.spoiler_text && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0.375rem 0.625rem",
              background: "var(--bg-elevated)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.875rem",
              marginBottom: "0.4rem",
              color: "var(--text-secondary)",
              gap: "0.5rem",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}><Icon name="exclamation-triangle" size="0.8rem" /> {status.spoiler_text}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", whiteSpace: "nowrap", flexShrink: 0 }}
              onClick={() => setCwExpanded((v) => !v)}
            >
              {cwExpanded ? t.cw_hide : t.cw_show}
            </button>
          </div>
        )}
        {showContent && (
          <div
            className="status-content"
            style={{ fontSize: isFocal ? "1.05rem" : "0.95rem", lineHeight: 1.6, overflowWrap: "break-word", wordBreak: "break-word" }}
          >
            <MemoRichText html={showTranslation && translatedContent ? translatedContent : renderedContent} />
          </div>
        )}
        {isFocal && (
          <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {new Date(status.created_at).toLocaleString()}
          </div>
        )}
        {showContent && <APTypeBlock apType={status.ap_type} apMeta={status.ap_meta} mediaAttachments={status.media_attachments ?? []} />}
        {showContent && status.quote && <QuoteInline quote={status.quote} />}
        {blurByFilter && !filterRevealed && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "0.35rem" }}>
            <Icon name="eye-slash" size="0.85rem" /> {t.filtered_by}: {filterTitles.join(", ")}
            <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "0.72rem", padding: "0.1rem 0.4rem", marginLeft: "auto" }} onClick={() => setFilterRevealed(true)}>
              {t.filtered_show}
            </button>
          </div>
        )}
        {showContent && <MediaGrid attachments={status.media_attachments ?? []} sensitive={status.sensitive || (blurByFilter && !filterRevealed)} defaultRevealed={prefs["reading:expand:media"] === "show_all"} />}
        {showContent && status.poll && <PollView poll={status.poll} />}
        {showContent && status.location && (
          <LocationPreview location={status.location} />
        )}
        {showContent && previewCard && (
          <LinkPreview card={previewCard} sensitive={status.sensitive || (blurByFilter && !filterRevealed)} />
        )}
        {showContent && (status.tags?.length ?? 0) > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.4rem" }}>
            {status.tags!.map((tag) => (
              <Link
                key={tag.name}
                href={`/tags/${encodeURIComponent(tag.name)}`}
                style={{ color: "var(--accent)", fontSize: "0.85rem", textDecoration: "none" }}
              >
                #{tag.name}
              </Link>
            ))}
          </div>
        )}
        {status.edited_at && (
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.3rem", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}><Icon name="pencil" size="0.7rem" /> {t.status_edited}</div>
        )}
        {!hideActions && (
        <div
          className="flex mt-3 gap-2 md:gap-5"
          style={{ color: "var(--text-muted)", fontSize: "0.82rem", flexWrap: "nowrap" }}
        >
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}
            onClick={() => onReply(status)}
            disabled={!token}
            aria-label={t.action_reply}
          >
            <Icon name="comment" /> {status.replies_count}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{
              padding: "0.2rem 0.4rem",
              gap: "0.35rem",
              color: reblogged ? "var(--accent)" : "var(--text-muted)",
              background: reblogged ? "var(--accent-bg)" : undefined,
              borderRadius: "var(--radius-sm)",
            }}
            onClick={() => void handleReblog()}
            disabled={!token}
            aria-label={t.action_reblog}
          >
            <Icon name="retweet" /> {reblogsCount}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{
              padding: "0.2rem 0.4rem",
              gap: "0.35rem",
              color: favourited ? "var(--danger)" : "var(--text-muted)",
              background: favourited ? "color-mix(in srgb, var(--danger) 12%, transparent)" : undefined,
              borderRadius: "var(--radius-sm)",
            }}
            onClick={() => void handleFav()}
            disabled={!token}
            aria-label={t.action_favourite}
          >
            {favourited ? <Icon name="heart" color="var(--danger)" /> : <Icon name="heart-o" />} {favouritesCount}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{
              padding: "0.2rem 0.4rem",
              gap: "0.35rem",
              color: bookmarked ? "var(--accent)" : "var(--text-muted)",
              background: bookmarked ? "var(--accent-bg)" : undefined,
              borderRadius: "var(--radius-sm)",
            }}
            onClick={() => void handleBookmark()}
            disabled={!token}
            title={bookmarked ? t.bookmark_remove : t.bookmark_add}
            aria-label={bookmarked ? t.bookmark_remove : t.bookmark_add}
          >
            {bookmarked ? <Icon name="bookmark" /> : <Icon name="bookmark-o" />}
          </button>
          {onQuote && status.visibility !== "direct" && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}
              onClick={() => onQuote(status)}
              disabled={!token}
              title={t.action_quote}
              aria-label={t.action_quote}
            >
              <Icon name="quote-left" />
            </button>
          )}
          {status.language && !(me && me.id === status.account.id) && status.language.slice(0, MAX_LANG_CODE_CHARS) !== locale.slice(0, MAX_LANG_CODE_CHARS) && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ padding: "0.2rem 0.4rem", gap: "0.35rem", fontSize: "0.7rem" }}
              onClick={() => void handleTranslate()}
              disabled={translating}
              title={status.language}
            >
              {translating ? "…" : showTranslation ? t.show_original : t.translate}
            </button>
          )}
          {status.license_url && (
            <Link
              href={`/licenses?url=${encodeURIComponent(status.license_url)}`}
              className="btn btn-ghost btn-sm"
              style={{ padding: "0.2rem 0.4rem", gap: "0.15rem" }}
              title={`${t.license_label}: ${licenseInfo?.name ?? status.license_url}`}
              aria-label={t.license_label}
            >
              <LicenseBadge license={licenseInfo ?? { url: status.license_url }} size="0.85rem" />
            </Link>
          )}
          <div ref={menuRef} style={{ position: "relative", marginLeft: "auto" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: "0.2rem 0.4rem", fontSize: "1rem", lineHeight: 1 }}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={t.action_open_menu}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <Icon name="ellipsis-h" />
            </button>
            {menuOpen && (
              <div
                style={{
                  position: "absolute", right: 0, top: "100%", zIndex: 50,
                  minWidth: 160, background: "var(--bg-surface)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  padding: "0.25rem 0", marginTop: "0.25rem",
                }}
              >
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{
                    width: "100%", justifyContent: "flex-start", gap: "0.5rem",
                    padding: "0.5rem 0.75rem", fontSize: "0.85rem",
                  }}
                  onClick={() => {
                    setMenuOpen(false);
                    router.push(`/reports/new?status_id=${encodeURIComponent(status.id)}&account_id=${encodeURIComponent(status.account.id)}`);
                  }}
              >
                <Icon name="flag" /> Report @{status.account.acct}
              </button>
              {me && me.id === status.account.id && (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{
                      width: "100%", justifyContent: "flex-start", gap: "0.5rem",
                      padding: "0.5rem 0.75rem", fontSize: "0.85rem",
                      color: pinned ? "var(--accent)" : undefined,
                    }}
                    onClick={() => { setMenuOpen(false); void handlePin(); }}
                  >
                    <Icon name="thumb-tack" /> {pinned ? t.pin_unpin : t.pin_pin}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{
                      width: "100%", justifyContent: "flex-start", gap: "0.5rem",
                      padding: "0.5rem 0.75rem", fontSize: "0.85rem",
                      color: muted ? "var(--danger)" : undefined,
                    }}
                    onClick={() => { setMenuOpen(false); void handleMute(); }}
                  >
                    <Icon name="volume-off" /> {muted ? t.mute_unmute : t.mute_mute}
                  </button>
                </>
              )}
              {(forceDelete || (me && me.id === status.account.id)) && (
                <div className="md:hidden">
                  {onEdit && me && me.id === status.account.id && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{
                        width: "100%", justifyContent: "flex-start", gap: "0.5rem",
                        padding: "0.5rem 0.75rem", fontSize: "0.85rem",
                      }}
                      onClick={() => { setMenuOpen(false); onEdit(status); }}
                    >
                      <Icon name="pencil" /> {t.action_edit}
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{
                        width: "100%", justifyContent: "flex-start", gap: "0.5rem",
                        padding: "0.5rem 0.75rem", fontSize: "0.85rem",
                        color: "var(--danger)",
                      }}
                      onClick={() => { setMenuOpen(false); onDelete(status); }}
                    >
                      <Icon name="trash" color="var(--danger)" /> {t.action_delete}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {(forceDelete || (me && me.id === status.account.id)) && (
            <>
              {onEdit && me && me.id === status.account.id && (
                <button
                  className="btn btn-ghost btn-sm btn-hide-mobile"
                  style={{ padding: "0.2rem 0.4rem" }}
                  onClick={() => onEdit(status)}
                  title={t.action_edit}
                  aria-label={t.action_edit}
                >
                  <Icon name="pencil" />
                </button>
              )}
              {onDelete && (
                <button
                  className="btn btn-ghost btn-sm btn-hide-mobile"
                  style={{ padding: "0.2rem 0.4rem", color: "var(--danger)" }}
                  onClick={() => onDelete(status)}
                  title={t.action_delete}
                  aria-label={t.action_delete}
                >
                  <Icon name="trash" color="var(--danger)" />
                </button>
              )}
            </>
          )}
        </div>
        </div>
        )}
        {hideActions && (forceDelete || (me && me.id === status.account.id)) && (
          <>
            {onEdit && me && me.id === status.account.id && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: "0.2rem 0.4rem", marginLeft: "auto" }}
                onClick={() => onEdit(status)}
                title={t.action_edit}
                aria-label={t.action_edit}
              >
                <Icon name="pencil" />
              </button>
            )}
            {onDelete && (
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: "0.2rem 0.4rem", color: "var(--danger)" }}
                onClick={() => onDelete(status)}
                title={t.action_delete}
                aria-label={t.action_delete}
              >
                <Icon name="trash" color="var(--danger)" />
              </button>
            )}
          </>
        )}
        {interactionList && (
          <InteractionList
            apiUrl={interactionList.url}
            title={interactionList.type === "favourited_by" ? "Favourited By" : "Reblogged By"}
            onClose={() => setInteractionList(null)}
          />
        )}
      </div>
    </article>
  );
}

/**
 * Boost wrapper: Mastodon shows a "{booster} boosted" header and the boosted
 * post below it. Interactions always target the inner status (`reblog`), so
 * the wrapper only adds the header and renders the body with the original.
 *
 * Memoised: timelines render hundreds of cards, and without this any parent
 * state change (e.g. typing in the composer) re-rendered every one of them.
 * Callers must keep the handler props stable (`useCallback`).
 */
export const StatusCard = memo(function StatusCard(props: ComponentProps<typeof StatusCardInner>) {
  const { t } = useLocale();
  const { status } = props;
  if (!status.reblog) return <StatusCardInner {...props} />;

  const booster = status.account;
  const boosterHref = booster.acct.includes("@")
    ? `/users/remote?url=${encodeURIComponent(booster.id)}`
    : `/users/${booster.username}`;
  return (
    <div className="status-card-boost">
      <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", padding: "0.5rem 1rem 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
        <Icon name="retweet" size="0.85rem" />
        <Link href={boosterHref} style={{ color: "var(--text-muted)", fontWeight: 600, textDecoration: "none" }}>
          {booster.display_name || booster.username}
        </Link>
        <span>{t.status_boosted}</span>
      </div>
      <StatusCardInner {...props} status={status.reblog} />
    </div>
  );
});
