"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { Lightbox } from "./Lightbox";
import { renderEmojiInHtml } from "@/lib/emoji";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";

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
  media_attachments: MediaAttachment[];
  sensitive: boolean;
  spoiler_text: string;
  language?: string | null;
  visibility?: string;
  poll: Poll | null;
  emojis?: EmojiData[];
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
      <img
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

export function MediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
  const closeLb = useCallback(() => setLbIdx(null), []);
  if (!attachments.length) return null;
  const gridCols = attachments.length === 1 ? 1 : attachments.length === 2 ? 2 : attachments.length <= 3 ? 3 : 2;
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
        }}
      >
        {attachments.map((att, i) => {
          if (att.type === "image" || att.type === "gifv") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => setLbIdx(i)}
                title={att.description ?? undefined}
                style={{
                  display: "block",
                  aspectRatio: attachments.length === 1 ? "16/9" : "1/1",
                  overflow: "hidden",
                  border: "none",
                  padding: 0,
                  cursor: "zoom-in",
                  background: "none",
                }}
              >
                <img
                  src={att.preview_url ?? att.url}
                  alt={att.description ?? ""}
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </button>
            );
          }
          if (att.type === "video") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => setLbIdx(i)}
                style={{
                  display: "block",
                  aspectRatio: "16/9",
                  overflow: "hidden",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  background: "var(--bg-elevated)",
                  position: "relative",
                }}
              >
                <video src={att.url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "2rem" }}>▶</div>
              </button>
            );
          }
          if (att.type === "audio") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => setLbIdx(i)}
                style={{
                  display: "block",
                  aspectRatio: "3/1",
                  overflow: "hidden",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: 0,
                  cursor: "pointer",
                  background: "var(--bg-elevated)",
                  position: "relative",
                }}
              >
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.25rem" }}>
                  <span style={{ fontSize: "2rem" }}>🎵</span>
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
      </div>
      {lbIdx !== null && (
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
                  <span style={{ fontWeight: isOwn ? 600 : 400 }}>{opt.title}{isOwn ? " ✓" : ""}</span>
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
            {voting ? "…" : "Votar"}
          </button>
        )}
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          {poll.votes_count} {poll.votes_count === 1 ? "voto" : "votos"}
          {poll.expires_at && <> · {poll.expired ? "Cerrada" : `Cierra ${new Date(poll.expires_at).toLocaleDateString()}`}</>}
          {poll.multiple && " · Opción múltiple"}
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
}: {
  status: Status;
  isFocal?: boolean;
  onFav: (s: Status) => void;
  onReblog: (s: Status) => void;
  onReply: (s: Status) => void;
  me?: Me | null;
  onDelete?: (s: Status) => void;
  onEdit?: (s: Status) => void;
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
  const [favouritesCount, setFavouritesCount] = useState(status.favourites_count);
  const [reblogsCount, setReblogsCount] = useState(status.reblogs_count);

  const token = getToken();
  const [translating, setTranslating] = useState(false);
  const [translatedContent, setTranslatedContent] = useState<string | null>(null);
  const [showTranslation, setShowTranslation] = useState(false);
  const { t: i18n } = useLocale();

  async function handleTranslate() {
    if (translatedContent) {
      setShowTranslation((v) => !v);
      return;
    }
    if (!status.language) return;
    setTranslating(true);
    try {
      const targetLang = navigator.language.slice(0, 2) || "en";
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: status.content,
          source_lang: status.language,
          target_lang: targetLang,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { translatedText?: string };
        if (data.translatedText) {
          setTranslatedContent(data.translatedText);
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
  useEffect(() => {
    setFavourited(status.favourited);
    setFavouritesCount(status.favourites_count);
  }, [status.id, status.favourited, status.favourites_count]);

  useEffect(() => {
    setReblogged(status.reblogged);
    setReblogsCount(status.reblogs_count);
  }, [status.id, status.reblogged, status.reblogs_count]);

  useEffect(() => {
    setBookmarked(status.bookmarked ?? false);
  }, [status.id, status.bookmarked]);

  const isRemote = status.account.acct.includes("@");
  const profileHref = isRemote
    ? `/users/remote?url=${encodeURIComponent(status.account.id)}`
    : `/users/${status.account.username}`;
  const threadHref = `/statuses/${encodeURIComponent(status.id)}`;
  const showContent = !status.spoiler_text || cwExpanded;

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
          <Link href={threadHref} title={new Date(status.created_at).toLocaleString()} style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "auto", textDecoration: "none" }}>
            {formatTime(status.created_at)}
          </Link>
        </div>
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
            <span>⚠️ {status.spoiler_text}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", whiteSpace: "nowrap", flexShrink: 0 }}
              onClick={() => setCwExpanded((v) => !v)}
            >
              {cwExpanded ? "Ocultar" : "Mostrar"}
            </button>
          </div>
        )}
        {showContent && (
          <div
            className="status-content"
            style={{ fontSize: isFocal ? "1.05rem" : "0.95rem", lineHeight: 1.6, overflowWrap: "break-word", wordBreak: "break-word" }}
            dangerouslySetInnerHTML={{ __html: showTranslation && translatedContent ? translatedContent : renderedContent }}
          />
        )}
        {isFocal && (
          <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {new Date(status.created_at).toLocaleString()}
          </div>
        )}
        {showContent && <MediaGrid attachments={status.media_attachments ?? []} />}
        {showContent && status.poll && <PollView poll={status.poll} />}
        {status.edited_at && (
          <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.3rem" }}>✏️ editado</div>
        )}
        <div className="flex gap-5 mt-3" style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}
            onClick={() => onReply(status)}
            disabled={!token}
          >
            💬 {status.replies_count}
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
          >
            🔁 {reblogsCount}
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
          >
            {favourited ? "❤️" : "🤍"} {favouritesCount}
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
            title={bookmarked ? "Quitar marcador" : "Añadir marcador"}
          >
            {bookmarked ? "🔖" : "🏷️"}
          </button>
          {status.language && (
            <button
              className="btn btn-ghost btn-sm"
              style={{ padding: "0.2rem 0.4rem", gap: "0.35rem", fontSize: "0.7rem", marginLeft: "auto" }}
              onClick={() => void handleTranslate()}
              disabled={translating}
              title={status.language}
            >
              {translating ? "…" : showTranslation ? i18n.show_original : i18n.translate}
            </button>
          )}
          {me && me.id === status.account.id && (
            <>
              {onEdit && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: "0.2rem 0.4rem", marginLeft: "auto" }}
                  onClick={() => onEdit(status)}
                  title="Editar"
                >
                  ✏️
                </button>
              )}
              {onDelete && (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ padding: "0.2rem 0.4rem", color: "var(--danger)", marginLeft: onEdit ? undefined : "auto" }}
                  onClick={() => onDelete(status)}
                  title="Eliminar"
                >
                  🗑️
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
