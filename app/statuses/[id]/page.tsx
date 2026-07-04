"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { Lightbox } from "@/components/Lightbox";
import { EmojiPicker } from "@/components/EmojiPicker";
import { renderEmojiInHtml } from "@/lib/emoji";

interface PollOption { title: string; votes_count: number | null }
interface Poll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number | null;
  voted: boolean;
  own_votes: number[];
  options: PollOption[];
  emojis: EmojiData[];
}

interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
  blurhash: string | null;
}

interface EmojiData {
  shortcode: string;
  url: string;
  static_url: string;
}

interface Status {
  id: string;
  content: string;
  created_at: string;
  in_reply_to_id: string | null;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MediaAttachment[];
  visibility: string;
  poll: Poll | null;
  emojis?: EmojiData[];
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return d.toLocaleDateString();
}

function Avatar({
  account,
  size = 42,
}: {
  account: Account;
  size?: number;
}) {
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
        background: "var(--accent-bg)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        fontSize: size * 0.45,
        fontWeight: 700,
        color: "var(--accent)",
      }}
    >
      {fallback}
    </div>
  );
}

function MediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
  const closeLb = useCallback(() => setLbIdx(null), []);
  if (!attachments.length) return null;
  const gridCols =
    attachments.length === 1 ? 1 : attachments.length === 2 ? 2 : attachments.length <= 3 ? 3 : 2;

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
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "2rem",
                  }}
                >
                  ▶
                </div>
              </button>
            );
          }
          if (att.type === "audio") {
            return (
              <button
                key={att.id}
                type="button"
                onClick={() => setLbIdx(i)}
                style={{ display: "block", aspectRatio: "3/1", overflow: "hidden", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 0, cursor: "pointer", background: "var(--bg-elevated)", position: "relative" }}
              >
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.25rem" }}>
                  <span style={{ fontSize: "2rem" }}>🎵</span>
                  {att.description && <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.description}</span>}
                </div>
              </button>
            );
          }
          return null;
        })}
      </div>
      {lbIdx !== null && (
        <Lightbox
          media={attachments.map((a) => ({
            url: a.url,
            preview_url: a.preview_url,
            description: a.description,
            type: a.type,
          }))}
          index={lbIdx}
          onClose={closeLb}
          onNav={setLbIdx}
        />
      )}
    </>
  );
}

function PollView({
  poll: initialPoll,
  token,
}: {
  poll: Poll;
  token: string | null;
}) {
  const [poll, setPoll] = useState<Poll>(initialPoll);
  const [voting, setVoting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const total = poll.votes_count > 0 ? poll.votes_count : 1;
  const showResults = poll.voted || poll.expired;
  const canVote = !poll.voted && !poll.expired && !!token;

  async function vote() {
    if (!token || voting || selected.length === 0) return;
    setVoting(true);
    try {
      const res = await fetch(`/api/v1/polls/${poll.id}/votes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ choices: selected }),
      });
      if (res.ok) setPoll((await res.json()) as Poll);
    } finally {
      setVoting(false);
    }
  }

  return (
    <div style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      {poll.options.map((opt, i) => {
        const pct = showResults && opt.votes_count != null ? Math.round((opt.votes_count / total) * 100) : 0;
        const isOwn = poll.own_votes.includes(i) || selected.includes(i);
        return (
          <div key={i} style={{ position: "relative" }}>
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
                onClick={() => {
                  if (poll.multiple) {
                    setSelected((p) => p.includes(i) ? p.filter((x) => x !== i) : [...p, i]);
                  } else {
                    setSelected([i]);
                  }
                }}
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
          {poll.expires_at && (
            <> · {poll.expired ? "Cerrada" : `Cierra ${new Date(poll.expires_at).toLocaleDateString()}`}</>
          )}
          {poll.multiple && " · Opción múltiple"}
        </span>
      </div>
    </div>
  );
}

// A single status card used in the thread (compact for ancestors/descendants, expanded for focal)
function StatusCard({
  status,
  isFocal = false,
  token,
  onFav,
  onReblog,
  onReply,
  me: meProp,
  onDelete,
  onEdit,
}: {
  status: Status;
  isFocal?: boolean;
  token: string | null;
  onFav: (s: Status) => void;
  onReblog: (s: Status) => void;
  onReply?: (s: Status) => void;
  me?: Me | null;
  onDelete?: (s: Status) => void;
  onEdit?: (s: Status) => void;
}) {
  const renderedContent = useMemo(
    () => renderEmojiInHtml(status.content, status.emojis ?? []),
    [status.content, status.emojis]
  );
  const isRemote = status.account.acct.includes("@");
  const profileHref = isRemote
    ? `/users/remote?url=${encodeURIComponent(status.account.id)}`
    : `/users/${status.account.username}`;
  const threadHref = `/statuses/${encodeURIComponent(status.id)}`;

  async function handleFav() {
    if (!token) return;
    const path = status.favourited ? "unfavourite" : "favourite";
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(status.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) onFav(status);
  }

  async function handleReblog() {
    if (!token) return;
    const path = status.reblogged ? "unreblog" : "reblog";
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(status.id)}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) onReblog(status);
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
        <Avatar account={status.account} size={isFocal ? 48 : 42} />
      </Link>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-baseline gap-2" style={{ marginBottom: "0.3rem", flexWrap: "wrap" }}>
          <Link
            href={profileHref}
            style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}
          >
            {status.account.display_name || status.account.username}
          </Link>
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            @{status.account.acct}
          </span>
          <Link
            href={threadHref}
            title={new Date(status.created_at).toLocaleString()}
            style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "auto", textDecoration: "none" }}
          >
            {formatTime(status.created_at)}
          </Link>
        </div>
        {status.spoiler_text && (
          <div
            style={{
              padding: "0.375rem 0.625rem",
              background: "var(--bg-elevated)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.875rem",
              marginBottom: "0.5rem",
              color: "var(--text-secondary)",
            }}
          >
            ⚠️ {status.spoiler_text}
          </div>
        )}
        <div
          className="status-content"
          style={{ fontSize: isFocal ? "1.05rem" : "0.95rem", lineHeight: 1.6 }}
          dangerouslySetInnerHTML={{ __html: renderedContent }}
        />
        {status.poll && <PollView poll={status.poll} token={token} />}
        {isFocal && (
          <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            {new Date(status.created_at).toLocaleString()}
          </div>
        )}
        <MediaGrid attachments={status.media_attachments ?? []} />
        <div className="flex gap-5 mt-3" style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}
            onClick={() => onReply?.(status)}
          >
            💬 {status.replies_count}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ padding: "0.2rem 0.4rem", gap: "0.35rem", color: status.reblogged ? "var(--accent)" : "var(--text-muted)" }}
            onClick={handleReblog}
          >
            🔁 {status.reblogs_count}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{
              padding: "0.2rem 0.4rem",
              gap: "0.35rem",
              color: status.favourited ? "var(--danger)" : "var(--text-muted)",
            }}
            onClick={handleFav}
          >
            {status.favourited ? "❤️" : "🤍"} {status.favourites_count}
          </button>
          {meProp && meProp.id === status.account.id && (
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
              <button
                className="btn btn-ghost btn-sm"
                style={{ padding: "0.2rem 0.4rem", color: "var(--danger)", marginLeft: onEdit ? undefined : "auto" }}
                onClick={() => onDelete?.(status)}
                title="Eliminar"
              >
                🗑️
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

// ─── Reply compose box ─────────────────────────────────────────────────────────

function ReplyBox({
  replyTo,
  me,
  token,
  onCancel,
  onPosted,
}: {
  replyTo: Status;
  me: Me | null;
  token: string | null;
  onCancel: () => void;
  onPosted: (newStatus: Status) => void;
}) {
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<"public" | "unlisted" | "followers" | "direct">(
    (["public", "unlisted", "followers", "direct"].includes(replyTo.visibility) ? replyTo.visibility : "public") as "public" | "unlisted" | "followers" | "direct"
  );
  const [mediaFiles, setMediaFiles] = useState<MediaAttachment[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCw, setShowCw] = useState(false);
  const [cwText, setCwText] = useState("");
  const [pollMode, setPollMode] = useState(false);
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollExpiry, setPollExpiry] = useState(86400);
  const [pollMultiple, setPollMultiple] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const descRefs = useRef<Record<string, string>>({});

  const closeEmoji = useCallback(() => setEmojiOpen(false), []);

  const insertEmoji = useCallback((emoji: string) => {
    const ta = textareaRef.current;
    if (!ta) { setText((c) => c + emoji); return; }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const next = text.slice(0, start) + emoji + text.slice(end);
    setText(next);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(start + emoji.length, start + emoji.length); }, 0);
  }, [text]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!token || !e.target.files?.length) return;
    const files = Array.from(e.target.files).slice(0, 4 - mediaFiles.length);
    e.target.value = "";
    setUploadingMedia(true);
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      try {
        const res = await fetch("/api/v1/media", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (res.ok) {
          const att = await res.json() as MediaAttachment;
          setMediaFiles((prev) => [...prev, att]);
        }
      } catch {
        // ignore
      }
    }
    setUploadingMedia(false);
  }

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && mediaFiles.length === 0 && !pollMode) return;
    setSubmitting(true);
    setError(null);
    try {
      const hasPoll = pollMode && pollOptions.filter((o) => o.trim()).length >= 2;
      const body: Record<string, unknown> = {
        status: text.trim(),
        in_reply_to_id: replyTo.id,
        visibility,
        media_ids: mediaFiles.map((f) => f.id),
      };
      if (showCw && cwText.trim()) { body.sensitive = true; body.spoiler_text = cwText.trim(); }
      if (hasPoll) {
        body.poll = {
          options: pollOptions.filter((o) => o.trim()),
          expires_in: pollExpiry,
          multiple: pollMultiple,
        };
      }
      // Flush any pending media descriptions before posting
      if (mediaFiles.length > 0) {
        await Promise.all(mediaFiles.map(async (f) => {
          const desc = descRefs.current[f.id];
          if (desc !== undefined) {
            await fetch(`/api/v1/media/${f.id}`, {
              method: "PUT",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ description: desc.trim() || null }),
            });
          }
        }));
      }
      const res = await fetch("/api/v1/statuses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        setError(err.error ?? "Failed to post reply");
      } else {
        const newStatus = await res.json() as Status;
        setText("");
        setMediaFiles([]);
        descRefs.current = {};
        setShowCw(false); setCwText(""); setPollMode(false); setPollOptions(["", ""]); setPollMultiple(false);
        onPosted(newStatus);
      }
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "0.75rem 1rem", background: "var(--bg-elevated)" }}>
      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
        Replying to <strong>@{replyTo.account.acct}</strong>
      </div>
      <div style={{ display: "flex", gap: "0.75rem" }}>
        {me && (
          <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: "50%", overflow: "hidden", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "var(--accent)", fontSize: "0.9rem" }}>
            {me.avatar
              ? <img src={me.avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : (me.display_name?.[0] ?? me.username?.[0] ?? "?").toUpperCase()}
          </div>
        )}
        <form onSubmit={handleSubmit} style={{ flex: 1 }}>
          {showCw && (
            <input
              type="text"
              value={cwText}
              onChange={(e) => setCwText(e.target.value)}
              placeholder="Advertencia de contenido…"
              maxLength={500}
              style={{ width: "100%", marginBottom: "0.4rem", padding: "0.4rem 0.75rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: "0.9rem", fontFamily: "inherit" }}
            />
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Post your reply..."
            rows={3}
            style={{ width: "100%", resize: "vertical", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: "0.95rem", fontFamily: "inherit" }}
          />
          {pollMode && (
            <div style={{ marginTop: "0.5rem", padding: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--bg)" }}>
              <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: "0.5rem" }}>Opciones de la encuesta</div>
              {pollOptions.map((opt, i) => (
                <div key={i} style={{ display: "flex", gap: "0.4rem", marginBottom: "0.35rem" }}>
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) => setPollOptions((p) => p.map((o, j) => j === i ? e.target.value : o))}
                    placeholder={`Opción ${i + 1}`}
                    maxLength={50}
                    style={{ flex: 1, padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: "0.875rem" }}
                  />
                  {pollOptions.length > 2 && (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "0.2rem 0.4rem" }} onClick={() => setPollOptions((p) => p.filter((_, j) => j !== i))}>✕</button>
                  )}
                </div>
              ))}
              {pollOptions.length < 4 && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "0.8rem", marginBottom: "0.5rem" }} onClick={() => setPollOptions((p) => [...p, ""])}>+ Agregar opción</button>
              )}
              <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.25rem" }}>
                <select value={pollExpiry} onChange={(e) => setPollExpiry(Number(e.target.value))} style={{ fontSize: "0.78rem", padding: "0.25rem 0.4rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", color: "var(--text)" }}>
                  <option value={3600}>1 hora</option>
                  <option value={21600}>6 horas</option>
                  <option value={86400}>1 día</option>
                  <option value={259200}>3 días</option>
                  <option value={604800}>1 semana</option>
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.82rem", cursor: "pointer" }}>
                  <input type="checkbox" checked={pollMultiple} onChange={(e) => setPollMultiple(e.target.checked)} />
                  Opción múltiple
                </label>
              </div>
            </div>
          )}
          {mediaFiles.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "0.5rem" }}>
              {mediaFiles.map((f) => (
                <div key={f.id} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                  <div style={{ position: "relative", flexShrink: 0, width: 64, height: 64 }}>
                    {f.type === "image" || f.type === "gifv" ? (
                      <img src={f.preview_url ?? f.url} alt={f.description ?? ""} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: "var(--radius-sm)" }} />
                    ) : (
                      <div style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.4rem" }}>{f.type === "audio" ? "🎵" : "🎬"}</div>
                    )}
                    <button type="button" onClick={() => setMediaFiles((prev) => prev.filter((x) => x.id !== f.id))} style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.65)", color: "#fff", border: "none", borderRadius: "50%", width: 16, height: 16, cursor: "pointer", fontSize: "0.6rem", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                  </div>
                  <input
                    type="text"
                    placeholder="Descripción (alt text)…"
                    defaultValue={f.description ?? ""}
                    maxLength={420}
                    onChange={(e) => { descRefs.current[f.id] = e.target.value; }}
                    onBlur={async (e) => {
                      if (!token) return;
                      const desc = e.target.value.trim() || null;
                      await fetch(`/api/v1/media/${f.id}`, {
                        method: "PUT",
                        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                        body: JSON.stringify({ description: desc }),
                      });
                      setMediaFiles((prev) => prev.map((x) => x.id === f.id ? { ...x, description: desc } : x));
                    }}
                    style={{ flex: 1, padding: "0.3rem 0.5rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: "0.8rem", fontFamily: "inherit" }}
                  />
                </div>
              ))}
              {uploadingMedia && <div style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>⏳</div>}
            </div>
          )}
          {error && <div style={{ color: "var(--danger)", fontSize: "0.82rem", marginTop: "0.25rem" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
              <div ref={emojiRef} style={{ position: "relative" }}>
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.05rem", padding: "0.2rem 0.35rem", background: emojiOpen ? "var(--accent-bg)" : undefined }} onClick={() => setEmojiOpen((o) => !o)} title="Emoji">😊</button>
                <EmojiPicker
                  onInsert={insertEmoji}
                  open={emojiOpen}
                  onClose={closeEmoji}
                  anchorRef={emojiRef}
                  direction="up"
                />
              </div>
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.05rem", padding: "0.2rem 0.35rem" }} onClick={() => fileInputRef.current?.click()} disabled={mediaFiles.length >= 4 || uploadingMedia || pollMode} title="Adjuntar">{uploadingMedia ? "⏳" : "📎"}</button>
              <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: "none" }} onChange={handleFileChange} />
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.05rem", padding: "0.2rem 0.35rem", background: showCw ? "var(--accent-bg)" : undefined }} onClick={() => setShowCw((v) => !v)} title="Advertencia de contenido">⚠️</button>
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.05rem", padding: "0.2rem 0.35rem", background: pollMode ? "var(--accent-bg)" : undefined }} onClick={() => setPollMode((v) => !v)} disabled={mediaFiles.length > 0} title="Encuesta">📊</button>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                style={{ fontSize: "0.78rem", padding: "0.25rem 0.4rem", cursor: "pointer", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", color: "var(--text)" }}
              >
                <option value="public">🌍 Public</option>
                <option value="unlisted">🔓 Unlisted</option>
                <option value="followers">👥 Followers</option>
                <option value="direct">📩 Direct</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={submitting || (!text.trim() && mediaFiles.length === 0 && !pollMode)}>
                {submitting ? "Posting\u2026" : "Reply"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ThreadPage() {
  const params = useParams();
  const router = useRouter();
  const rawId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? params.id[0] : "";
  const statusId = decodeURIComponent(rawId);

  const [me, setMe] = useState<Me | null>(null);
  const [focal, setFocal] = useState<Status | null>(null);
  const [ancestors, setAncestors] = useState<Status[]>([]);
  const [descendants, setDescendants] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyTarget, setReplyTarget] = useState<Status | null>(null);
  const [autoReply, setAutoReply] = useState(false);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpoiler, setEditSpoiler] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const searchParams = useSearchParams();
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;

  useEffect(() => {
    if (searchParams.get("reply") === "1") {
      setAutoReply(true);
      router.replace(`/statuses/${encodeURIComponent(statusId)}`, { scroll: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (autoReply && focal) {
      setReplyTarget(focal);
      setAutoReply(false);
    }
  }, [autoReply, focal]);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void load();
    void fetchMe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusId]);

  async function load() {
    setLoading(true);
    try {
      const [statusRes, contextRes] = await Promise.all([
        fetch(`/api/v1/statuses/${encodeURIComponent(statusId)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
        fetch(`/api/v1/statuses/${encodeURIComponent(statusId)}/context`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
      ]);

      if (statusRes.ok) setFocal(await statusRes.json() as Status);
      if (contextRes.ok) {
        const ctx = await contextRes.json() as { ancestors: Status[]; descendants: Status[] };
        setAncestors(ctx.ancestors ?? []);
        setDescendants(ctx.descendants ?? []);
      }
    } catch (e) {
      console.error("Failed to load thread", e);
    }
    setLoading(false);
  }

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  function handleFav(toggled: Status) {
    const update = (s: Status): Status =>
      s.id === toggled.id
        ? { ...s, favourited: !s.favourited, favourites_count: s.favourites_count + (s.favourited ? -1 : 1) }
        : s;
    setFocal((f) => (f ? update(f) : f));
    setAncestors((prev) => prev.map(update));
    setDescendants((prev) => prev.map(update));
  }

  function handleReblog(toggled: Status) {
    const update = (s: Status): Status =>
      s.id === toggled.id
        ? { ...s, reblogged: !s.reblogged, reblogs_count: s.reblogs_count + (s.reblogged ? -1 : 1) }
        : s;
    setFocal((f) => (f ? update(f) : f));
    setAncestors((prev) => prev.map(update));
    setDescendants((prev) => prev.map(update));
  }

  const replyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (replyTarget) {
      setTimeout(() => {
        replyRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
  }, [replyTarget]);

  function handleReply(s: Status) {
    setReplyTarget((prev) => (prev?.id === s.id ? null : s));
  }

  function handlePosted(newStatus: Status) {
    setReplyTarget(null);
    // Increment reply count on parent
    const bumpReplies = (s: Status): Status =>
      s.id === newStatus.in_reply_to_id ? { ...s, replies_count: s.replies_count + 1 } : s;
    setFocal((f) => (f ? bumpReplies(f) : f));
    setAncestors((prev) => prev.map(bumpReplies));
    // Append new reply to descendants
    setDescendants((prev) => [...prev, newStatus]);
  }

  async function handleDelete(s: Status) {
    if (!token) return;
    if (!confirm("¿Eliminar este estado?")) return;
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(s.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      if (focal?.id === s.id) {
        router.back();
      } else {
        setAncestors((prev) => prev.filter((x) => x.id !== s.id));
        setDescendants((prev) => prev.filter((x) => x.id !== s.id));
      }
    }
  }

  function openEdit(s: Status) {
    const div = typeof document !== "undefined" ? document.createElement("div") : null;
    if (div) {
      div.innerHTML = s.content.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
      setEditText((div.textContent ?? div.innerText ?? "").trim());
    } else {
      setEditText(s.content.replace(/<[^>]*>/g, "").trim());
    }
    setEditSpoiler(s.spoiler_text ?? "");
    setEditingStatus(s);
  }

  async function handleEditSave() {
    if (!editText.trim() || !editingStatus || !token) return;
    setEditBusy(true);
    const res = await fetch(`/api/v1/statuses/${editingStatus.id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: editText, spoiler_text: editSpoiler, sensitive: !!editSpoiler }),
    });
    if (res.ok) {
      const updated = await res.json() as Status;
      const updateList = (prev: Status[]) => prev.map((x) => (x.id === editingStatus.id ? updated : x));
      setFocal((f) => (f?.id === editingStatus.id ? updated : f));
      setAncestors(updateList);
      setDescendants(updateList);
      setEditingStatus(null);
    }
    setEditBusy(false);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="" />

      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Back header */}
        <div
          style={{
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            borderBottom: "1px solid var(--border)",
            padding: "0.75rem 1rem",
            display: "flex",
            alignItems: "center",
            gap: "1rem",
            zIndex: 10,
          }}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => router.back()}
            style={{ fontSize: "1.1rem" }}
          >
            ←
          </button>
          <span style={{ fontWeight: 600 }}>Post</span>
        </div>

        {loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            Loading thread...
          </div>
        ) : !focal ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            Post not found.
          </div>
        ) : (
          <>
            {/* Ancestors */}
            {ancestors.map((s) => (
              <>
                <StatusCard key={s.id} status={s} token={token} onFav={handleFav} onReblog={handleReblog} onReply={handleReply} me={me} onDelete={handleDelete} onEdit={openEdit} />
                {replyTarget?.id === s.id && (
                  <ReplyBox key={`reply-${s.id}`} replyTo={s} me={me} token={token} onCancel={() => setReplyTarget(null)} onPosted={handlePosted} />
                )}
              </>
            ))}

            {/* Focal status (highlighted) */}
            <StatusCard status={focal} isFocal token={token} onFav={handleFav} onReblog={handleReblog} onReply={handleReply} me={me} onDelete={handleDelete} onEdit={openEdit} />
            {replyTarget?.id === focal.id && (
              <div ref={replyRef}>
                <ReplyBox replyTo={focal} me={me} token={token} onCancel={() => setReplyTarget(null)} onPosted={handlePosted} />
              </div>
            )}

            {/* Descendants */}
            {descendants.length > 0 && (
              <div
                style={{
                  padding: "0.5rem 1rem",
                  fontSize: "0.8rem",
                  color: "var(--text-muted)",
                  borderBottom: "1px solid var(--border)",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                }}
              >
                Replies
              </div>
            )}
            {descendants.map((s) => (
              <>
                <StatusCard key={s.id} status={s} token={token} onFav={handleFav} onReblog={handleReblog} onReply={handleReply} me={me} onDelete={handleDelete} onEdit={openEdit} />
                {replyTarget?.id === s.id && (
                  <ReplyBox key={`reply-${s.id}`} replyTo={s} me={me} token={token} onCancel={() => setReplyTarget(null)} onPosted={handlePosted} />
                )}
              </>
            ))}
          </>
        )}

        {/* Edit status modal */}
        {editingStatus && (
          <div
            role="dialog"
            aria-modal="true"
            style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}
            onClick={(e) => { if (e.target === e.currentTarget) setEditingStatus(null); }}
          >
            <div style={{ background: "var(--bg)", borderRadius: "var(--radius-lg)", padding: "1.25rem", width: "min(520px, 95vw)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, fontSize: "1rem" }}>Editar estado</span>
                <button type="button" onClick={() => setEditingStatus(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.1rem", padding: "0.25rem" }}>✕</button>
              </div>
              {editSpoiler !== "" || editingStatus.spoiler_text ? (
                <input
                  type="text"
                  value={editSpoiler}
                  onChange={(e) => setEditSpoiler(e.target.value)}
                  placeholder="Advertencia de contenido"
                  className="input"
                  style={{ width: "100%" }}
                />
              ) : null}
              <textarea
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                placeholder="Edita tu estado…"
                maxLength={500}
                className="input"
                style={{ resize: "none", minHeight: 120, fontFamily: "inherit", width: "100%" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{editText.length}/500</span>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingStatus(null)}>Cancelar</button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={!editText.trim() || editBusy} onClick={() => void handleEditSave()}>
                    {editBusy ? "…" : "Guardar"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
