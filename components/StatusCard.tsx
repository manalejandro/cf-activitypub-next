"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Lightbox } from "./Lightbox";
import { InteractionList } from "./InteractionList";
import { RichText } from "./RichText";
import { renderEmojiInHtml } from "@/lib/emoji";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { APTypeBlock, TypeBadge, type APMeta } from "./APTypeBlock";
import { Icon } from "./Icon";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Account {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
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
  emojis?: EmojiData[];
  ap_type?: string | null;
  ap_meta?: APMeta | null;
}

export interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
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

export function MediaGrid({ attachments, sensitive }: { attachments: MediaAttachment[]; sensitive?: boolean }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const closeLb = useCallback(() => setLbIdx(null), []);
  const { t } = useLocale();
  if (!attachments.length) return null;
  // Blur by default when the status is sensitive or any attachment is sensitive
  // (Mastodon behaviour), until the user explicitly reveals the media.
  const blurred = !revealed && (sensitive === true || attachments.some((a) => a.sensitive));
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
          if (att.type === "image" || att.type === "gifv") {
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
          if (att.type === "video") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => { if (!blurred) setLbIdx(i); }}
                aria-label={att.description ?? t.action_view_media}
                style={{
                  display: "block",
                  aspectRatio: "16/9",
                  overflow: "hidden",
                  border: "none",
                  padding: 0,
                  cursor: blurred ? "default" : "pointer",
                  background: "var(--bg-elevated)",
                  position: "relative",
                }}
              >
                <video src={att.url} style={{ width: "100%", height: "100%", objectFit: "cover", filter: blurred ? "blur(12px)" : undefined }} />
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="play" color="rgba(255,255,255,0.9)" /></div>
              </button>
            );
          }
          if (att.type === "audio") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => { if (!blurred) setLbIdx(i); }}
                aria-label={att.description ?? t.action_view_media}
                style={{
                  display: "block",
                  aspectRatio: "3/1",
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: 0,
                  cursor: blurred ? "default" : "pointer",
                  background: "var(--bg-elevated)",
                  position: "relative",
                }}
              >
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.25rem" }}>
                  <span style={{ fontSize: "2rem", lineHeight: 1 }}><Icon name="music" size="2rem" /></span>
                  {att.description && (
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {att.description}
                    </span>
                  )}
                </div>
              </button>
            );
          }
          return null;
        })}
        {blurred && revealBtn}
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
          {poll.expires_at && <> · {poll.expired ? t.poll_closed : t.poll_closes.replace("{date}", new Date(poll.expires_at).toLocaleDateString())}</>}
          {poll.multiple && ` · ${t.poll_multiple}`}
        </span>
      </div>
    </div>
  );
}

// ─── StatusCard ───────────────────────────────────────────────────────────────

export function StatusCard({
  status,
  isFocal = false,
  onFav,
  onReblog,
  onReply,
  me,
  onDelete,
  onEdit,
  onPin,
  forceDelete = false,
  hideActions = false,
}: {
  status: Status;
  isFocal?: boolean;
  onFav: (s: Status) => void;
  onReblog: (s: Status) => void;
  onReply: (s: Status) => void;
  me?: Me | null;
  onDelete?: (s: Status) => void;
  onEdit?: (s: Status) => void;
  onPin?: (s: Status) => void;
  forceDelete?: boolean;
  hideActions?: boolean;
}) {
  const [cwExpanded, setCwExpanded] = useState(false);
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
      const targetLang = navigator.language.slice(0, 2) || "en";
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

  const visibilityInfo = (() => {
    switch (status.visibility) {
      case "unlisted": return { icon: "unlock", label: t.vis_unlisted };
      case "followers": return { icon: "lock", label: t.vis_followers };
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
    if (!res.ok) setBookmarked(wasBookmarked);
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
            {status.account.display_name || status.account.username}
          </Link>
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{status.account.acct}</span>
          {pinned && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "0.25rem", display: "inline-flex" }}><Icon name="thumb-tack" size="0.7rem" /></span>}
          <span
            title={visibilityInfo.label}
            style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "auto", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: "0.3rem" }}
          >
            <Icon name={visibilityInfo.icon} size="0.7rem" /> <span className="hidden md:inline">{visibilityInfo.label}</span>
          </span>
          <Link href={threadHref} title={new Date(status.created_at).toLocaleString()} aria-label={`${new Date(status.created_at).toLocaleString()}, ${t.action_reply}`} style={{ fontSize: "0.78rem", color: "var(--text-muted)", textDecoration: "none" }}>
            {formatTime(status.created_at)}
          </Link>
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
            <RichText html={showTranslation && translatedContent ? translatedContent : renderedContent} />
          </div>
        )}
        {isFocal && (
          <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {new Date(status.created_at).toLocaleString()}
          </div>
        )}
        {showContent && <APTypeBlock apType={status.ap_type} apMeta={status.ap_meta} mediaAttachments={status.media_attachments ?? []} />}
        {showContent && <MediaGrid attachments={status.media_attachments ?? []} sensitive={status.sensitive} />}
        {showContent && status.poll && <PollView poll={status.poll} />}
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
          {status.language && !(me && me.id === status.account.id) && status.language.slice(0, 2) !== locale.slice(0, 2) && (
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
