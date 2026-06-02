"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { Lightbox } from "@/components/Lightbox";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";

interface Account {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
}

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
  blurhash: string | null;
}

interface PollOption { title: string; votes_count: number | null }
interface Poll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  multiple: boolean;
  votes_count: number;
  voters_count: number;
  voted: boolean;
  own_votes: number[];
  options: PollOption[];
}

interface Status {
  id: string;
  content: string;
  created_at: string;
  edited_at: string | null;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  media_attachments: MediaAttachment[];
  sensitive: boolean;
  spoiler_text: string;
  language: string | null;
  poll: Poll | null;
}

// ─── Emoji categories (inline, no library) ─────────────────────────────────
const EMOJI_CATEGORIES = [
  { name: "Caritas", emojis: ["😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🥸","😏","😒","😞","😔","😟","😕","🙁","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🫡","🤔","🤭","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤑","🤒","🤕","🤢","🤮","🤧","🥴","😵‍💫","🤠","🥳","🥸","🤡","👹","👺","💀","👻","👽","🤖","💩"] },
  { name: "Gestos", emojis: ["👋","🤚","🖐","✋","🖖","👌","🤌","✌️","🤞","🤟","🤘","👈","👉","👆","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","🤲","🤝","🙏","💪","🦾","🖕","✍️","💅","🫶","❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☯️","🔥","💯","✨","⭐","🌟","💫","💥","💢","💬","💭","💤"] },
  { name: "Naturaleza", emojis: ["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🦆","🦅","🦉","🦇","🐝","🌸","🌺","🌻","🌹","🍀","🌿","🍃","🌲","🌴","🌵","🌾","🍁","🍂","🌍","🌎","🌏","🌙","🌞","⭐","☁️","⛅","🌈","⛄","🌊","🔥"] },
  { name: "Comida", emojis: ["🍕","🍔","🌮","🌯","🥗","🍜","🍣","🍱","🍛","🍲","🥘","🍝","🥞","🧇","🥓","🌭","🍟","🍿","🧆","🥚","🍳","🥐","🥨","🥖","🧀","🥗","🍎","🍊","🍋","🍇","🍓","🍑","🍒","🥭","🍍","🥝","🍦","🍧","🍨","🍩","🍪","🎂","🍰","🧁","☕","🍵","🧃","🥤","🍺","🍻","🥂","🍷"] },
  { name: "Actividades", emojis: ["⚽","🏀","🏈","⚾","🎾","🏐","🏉","🎱","🏓","🏸","🥊","🎯","🎮","🎲","🎨","🖼️","🎭","🎬","🎤","🎧","🎸","🎹","🥁","🎷","🎺","🎻","🎙️","🎚️","📸","📷","🎥","📹","🎞️","📺","📻","🎁","🎀","🎊","🎉","🎈","🏆","🥇","🎖️","🏅","🚴","🧗","🏊","🤸","⛷️","🏄"] },
  { name: "Objetos", emojis: ["📱","💻","🖥️","⌨️","🖱️","📷","📚","📖","📝","✏️","🖊️","🖋️","📌","📍","✂️","🗂️","📁","📂","🗑️","🔑","🔒","🔓","🔔","🔕","🔊","🔇","🔈","📢","💡","🔦","🕯️","🧲","🔧","🔩","⚙️","🔬","🔭","💊","💉","🩺","🩹","🚑","🚒","🚓","🚗","✈️","🚀","⛵","🏠","🏢","🗺️","🌐"] },
];

function MediaGrid({ attachments }: { attachments: MediaAttachment[] }) {
  const [lbIdx, setLbIdx] = useState<number | null>(null);
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
          media={attachments.map((a) => ({ url: a.url, preview_url: a.preview_url, description: a.description, type: a.type }))}
          index={lbIdx}
          onClose={() => setLbIdx(null)}
          onNav={setLbIdx}
        />
      )}
    </>
  );
}

function PollView({
  poll,
  token,
  onVoted,
}: {
  poll: Poll;
  token: string | null;
  onVoted: (updated: Poll) => void;
}) {
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
      if (res.ok) onVoted((await res.json()) as Poll);
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
              <div
                style={{
                  position: "relative", borderRadius: "var(--radius-sm)",
                  overflow: "hidden", background: "var(--bg-elevated)",
                  padding: "0.35rem 0.75rem",
                }}
              >
                <div
                  style={{
                    position: "absolute", left: 0, top: 0, bottom: 0,
                    width: `${pct}%`, background: isOwn ? "var(--accent-bg)" : "color-mix(in srgb, var(--accent-bg) 40%, transparent)",
                    transition: "width 0.4s",
                  }}
                />
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
                style={{
                  width: "100%", textAlign: "left", padding: "0.35rem 0.75rem",
                  border: `1.5px solid ${selected.includes(i) ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: "var(--radius-sm)",
                  background: selected.includes(i) ? "var(--accent-bg)" : "transparent",
                  cursor: "pointer", fontSize: "0.875rem", color: "var(--text)",
                }}
              >
                {opt.title}
              </button>
            )}
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
        {canVote && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={selected.length === 0 || voting}
            onClick={() => void vote()}
          >
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

export default function HomePage() {
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [me, setMe] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState("");
  const [posting, setPosting] = useState(false);
  const [mediaFiles, setMediaFiles] = useState<MediaAttachment[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "unlisted" | "followers" | "direct">("public");
  const [replyTo, setReplyTo] = useState<Status | null>(null);
  const [replyText, setReplyText] = useState("");
  const [replyVisibility, setReplyVisibility] = useState<"public" | "unlisted" | "followers" | "direct">("public");
  const [replyPosting, setReplyPosting] = useState(false);
  const [replyMediaFiles, setReplyMediaFiles] = useState<MediaAttachment[]>([]);
  const [replyUploadingMedia, setReplyUploadingMedia] = useState(false);
  const [replyEmojiOpen, setReplyEmojiOpen] = useState(false);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpoiler, setEditSpoiler] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  const replyFileInputRef = useRef<HTMLInputElement>(null);
  const replyEmojiRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mediaDescRefs = useRef<Record<string, string>>({});
  const replyDescRefs = useRef<Record<string, string>>({});
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const seenIdsRef = useRef<Set<string>>(new Set());
  const { t } = useLocale();

  // Real-time home feed streaming
  useTimelineStream("user", token, (event, payload) => {
    if (event !== "update") return;
    try {
      const status = JSON.parse(payload) as Status;
      if (seenIdsRef.current.has(status.id)) return;
      seenIdsRef.current.add(status.id);
      setStatuses((prev) => [status, ...prev]);
    } catch { /* ignore */ }
  }, { enabled: !!token });

  // CW compose state
  const [showCw, setShowCw] = useState(false);
  const [cwText, setCwText] = useState("");
  // Poll compose state
  const [pollMode, setPollMode] = useState(false);
  const [pollOptions, setPollOptions] = useState(["", ""]);
  // Reply CW state
  const [replyCw, setReplyCw] = useState(false);
  const [replyCwText, setReplyCwText] = useState("");
  // Reply poll state
  const [replyPollMode, setReplyPollMode] = useState(false);
  const [replyPollOptions, setReplyPollOptions] = useState(["", ""]);
  const [replyPollExpiry, setReplyPollExpiry] = useState(86400);
  const [replyPollMultiple, setReplyPollMultiple] = useState(false);
  const [pollExpiry, setPollExpiry] = useState(86400);
  const [pollMultiple, setPollMultiple] = useState(false);
  // CW expansion state for timeline statuses
  const [expandedCw, setExpandedCw] = useState<Set<string>>(new Set());

  // Infinite scroll sentinel
  useEffect(() => {
    const el = bottomRef.current;
    if (!el || loadingMore || !hasMore) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) void loadMore(); },
      { rootMargin: "300px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loadingMore, statuses]);

  // Close emoji picker when clicking outside
  useEffect(() => {
    if (!emojiOpen) return;
    function handleOutside(e: MouseEvent) {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setEmojiOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [emojiOpen]);

  useEffect(() => {
    if (!replyEmojiOpen) return;
    function handleOutsideReply(e: MouseEvent) {
      if (replyEmojiRef.current && !replyEmojiRef.current.contains(e.target as Node)) {
        setReplyEmojiOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideReply);
    return () => document.removeEventListener("mousedown", handleOutsideReply);
  }, [replyEmojiOpen]);

  useEffect(() => {
    if (!token) { window.location.href = "/login"; return; }
    void fetchTimeline();
    void fetchMe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchTimeline() {
    if (!token) return;
    const res = await fetch("/api/v1/timelines/home", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses(data);
      setHasMore(data.length >= 20);
      seenIdsRef.current = new Set(data.map((s) => s.id));
    }
    setLoading(false);
  }

  async function loadMore() {
    if (!token || loadingMore || !hasMore) return;
    const oldestId = statuses[statuses.length - 1]?.id;
    if (!oldestId) return;
    setLoadingMore(true);
    const res = await fetch(`/api/v1/timelines/home?max_id=${oldestId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses((prev) => [...prev, ...data]);
      setHasMore(data.length >= 20);
    }
    setLoadingMore(false);
  }

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Account);
  }

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    const hasPoll = pollMode && pollOptions.filter((o) => o.trim()).length >= 2;
    if ((!composing.trim() && mediaFiles.length === 0 && !hasPoll) || !token) return;
    setPosting(true);
    setEmojiOpen(false);
    const body: Record<string, unknown> = {
      status: composing,
      media_ids: mediaFiles.map((f) => f.id),
      visibility,
      sensitive: showCw,
      spoiler_text: showCw ? cwText : "",
    };
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
        const desc = mediaDescRefs.current[f.id];
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
    if (res.ok) {
      setComposing("");
      setMediaFiles([]);
      mediaDescRefs.current = {};
      setShowCw(false);
      setCwText("");
      setPollMode(false);
      setPollOptions(["", ""]);
      setPollMultiple(false);
      await fetchTimeline();
    }
    setPosting(false);
  }

  const insertEmoji = useCallback((emoji: string) => {
    const ta = textareaRef.current;
    if (!ta) { setComposing((c) => c + emoji); return; }
    const start = ta.selectionStart ?? composing.length;
    const end = ta.selectionEnd ?? composing.length;
    const next = composing.slice(0, start) + emoji + composing.slice(end);
    setComposing(next);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(start + emoji.length, start + emoji.length); }, 0);
  }, [composing]);

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
        // ignore individual upload errors
      }
    }
    setUploadingMedia(false);
  }

  async function updateMediaDesc(id: string, description: string, setter: React.Dispatch<React.SetStateAction<MediaAttachment[]>>) {
    if (!token) return;
    await fetch(`/api/v1/media/${id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ description: description.trim() || null }),
    });
    setter((prev) => prev.map((f) => f.id === id ? { ...f, description: description.trim() || null } : f));
  }

  const insertReplyEmoji = useCallback((emoji: string) => {
    const ta = replyTextareaRef.current;
    if (!ta) { setReplyText((c) => c + emoji); return; }
    const start = ta.selectionStart ?? replyText.length;
    const end = ta.selectionEnd ?? replyText.length;
    const next = replyText.slice(0, start) + emoji + replyText.slice(end);
    setReplyText(next);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(start + emoji.length, start + emoji.length); }, 0);
  }, [replyText]);

  async function handleReplyFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!token || !e.target.files?.length) return;
    const files = Array.from(e.target.files).slice(0, 4 - replyMediaFiles.length);
    e.target.value = "";
    setReplyUploadingMedia(true);
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
          setReplyMediaFiles((prev) => [...prev, att]);
        }
      } catch {
        // ignore
      }
    }
    setReplyUploadingMedia(false);
  }

  async function handleReply() {
    const hasReplyPoll = replyPollMode && replyPollOptions.filter((o) => o.trim()).length >= 2;
    if ((!replyText.trim() && replyMediaFiles.length === 0 && !hasReplyPoll) || !replyTo || !token) return;
    setReplyPosting(true);
    const body: Record<string, unknown> = {
      status: replyText,
      in_reply_to_id: replyTo.id,
      visibility: replyVisibility,
      media_ids: replyMediaFiles.map((f) => f.id),
      sensitive: replyCw,
      spoiler_text: replyCw ? replyCwText : "",
    };
    if (hasReplyPoll) {
      body.poll = {
        options: replyPollOptions.filter((o) => o.trim()),
        expires_in: replyPollExpiry,
        multiple: replyPollMultiple,
      };
    }
    // Flush any pending reply media descriptions before posting
    if (replyMediaFiles.length > 0) {
      await Promise.all(replyMediaFiles.map(async (f) => {
        const desc = replyDescRefs.current[f.id];
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
    if (res.ok) {
      setReplyText("");
      setReplyMediaFiles([]);
      replyDescRefs.current = {};
      setReplyCw(false);
      setReplyCwText("");
      setReplyPollMode(false);
      setReplyPollOptions(["", ""]);
      setReplyPollMultiple(false);
      setReplyTo(null);
      await fetchTimeline();
    }
    setReplyPosting(false);
  }

  async function toggleFavourite(s: Status) {
    if (!token) return;
    const path = s.favourited ? "unfavourite" : "favourite";
    const res = await fetch(`/api/v1/statuses/${s.id}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) =>
        prev.map((x) =>
          x.id === s.id
            ? { ...x, favourited: !s.favourited, favourites_count: s.favourites_count + (s.favourited ? -1 : 1) }
            : x
        )
      );
    }
  }

  function openEdit(s: Status) {
    // Strip HTML tags to get editable plain text
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
      setStatuses((prev) => prev.map((x) => (x.id === editingStatus.id ? updated : x)));
      setEditingStatus(null);
    }
    setEditBusy(false);
  }

  async function handleDelete(s: Status) {
    if (!token) return;
    if (!confirm("¿Eliminar este estado?")) return;
    const res = await fetch(`/api/v1/statuses/${s.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) => prev.filter((x) => x.id !== s.id));
    }
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString();
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/home" />

      {/* Main feed */}
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Compose */}
        <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
          <form onSubmit={handlePost} className="flex flex-col gap-3">
            {/* CW input */}
            {showCw && (
              <input
                type="text"
                className="input"
                placeholder="Advertencia de contenido…"
                value={cwText}
                onChange={(e) => setCwText(e.target.value)}
                maxLength={200}
                style={{ fontSize: "0.9rem" }}
              />
            )}
            {/* Textarea */}
            <div>
              <textarea
                ref={textareaRef}
                className="input"
                style={{ resize: "none", minHeight: 80, fontFamily: "inherit" }}
                placeholder={t.compose_placeholder}
                value={composing}
                onChange={(e) => setComposing(e.target.value)}
                maxLength={500}
              />
            </div>

            {/* Poll options */}
            {pollMode && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", padding: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.25rem" }}>Opciones de la encuesta</div>
                {pollOptions.map((opt, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="text"
                      className="input"
                      placeholder={`Opción ${i + 1}`}
                      value={opt}
                      onChange={(e) => setPollOptions((p) => p.map((o, j) => j === i ? e.target.value : o))}
                      maxLength={50}
                      style={{ flex: 1, fontSize: "0.875rem" }}
                    />
                    {pollOptions.length > 2 && (
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "0.25rem 0.4rem" }} onClick={() => setPollOptions((p) => p.filter((_, j) => j !== i))}>✕</button>
                    )}
                  </div>
                ))}
                {pollOptions.length < 4 && (
                  <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", fontSize: "0.8rem" }} onClick={() => setPollOptions((p) => [...p, ""])}>+ Añadir opción</button>
                )}
                <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                  <select value={pollExpiry} onChange={(e) => setPollExpiry(Number(e.target.value))} className="btn btn-ghost btn-sm" style={{ fontSize: "0.78rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--text)" }}>
                    <option value={300}>5 minutos</option>
                    <option value={3600}>1 hora</option>
                    <option value={21600}>6 horas</option>
                    <option value={86400}>1 día</option>
                    <option value={259200}>3 días</option>
                    <option value={604800}>7 días</option>
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", cursor: "pointer" }}>
                    <input type="checkbox" checked={pollMultiple} onChange={(e) => setPollMultiple(e.target.checked)} />
                    Opción múltiple
                  </label>
                </div>
              </div>
            )}

            {/* Media previews */}
            {mediaFiles.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {mediaFiles.map((f) => (
                  <div key={f.id} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                    <div style={{ position: "relative", flexShrink: 0, width: 72, height: 72 }}>
                      {f.type === "image" || f.type === "gifv" ? (
                        <img src={f.preview_url ?? f.url} alt={f.description ?? ""} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: "var(--radius-sm)" }} />
                      ) : (
                        <div style={{ width: 72, height: 72, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem" }}>{f.type === "audio" ? "🎵" : "🎬"}</div>
                      )}
                      <button type="button" onClick={() => setMediaFiles((prev) => prev.filter((x) => x.id !== f.id))}
                        style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.65)", color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: "0.65rem", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                    </div>
                    <input
                      type="text"
                      placeholder="Descripción (alt text)…"
                      defaultValue={f.description ?? ""}
                      maxLength={420}
                      onChange={(e) => { mediaDescRefs.current[f.id] = e.target.value; }}
                      onBlur={(e) => void updateMediaDesc(f.id, e.target.value, setMediaFiles)}
                      style={{ flex: 1, padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: "0.82rem", fontFamily: "inherit" }}
                    />
                  </div>
                ))}
                {uploadingMedia && (
                  <div style={{ width: 72, height: 72, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem" }}>⏳</div>
                )}
              </div>
            )}

            {/* Toolbar + counter + submit */}
            <div className="flex items-center justify-between">
              <div style={{ display: "flex", gap: "0.25rem", alignItems: "center", position: "relative" }}>
                {/* Emoji button + picker */}
                <div ref={emojiRef} style={{ position: "relative" }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: "1.15rem", padding: "0.3rem 0.5rem", background: emojiOpen ? "var(--accent-bg)" : undefined }}
                    onClick={() => setEmojiOpen((o) => !o)}
                    title="Emoji"
                  >
                    😊
                  </button>
                  {emojiOpen && (
                    <div
                      style={{
                        position: "absolute", top: "calc(100% + 6px)", left: 0,
                        background: "var(--bg-elevated)", border: "1px solid var(--border)",
                        borderRadius: "var(--radius-lg)", padding: "0.75rem",
                        zIndex: 50, width: 320, maxHeight: 260, overflowY: "auto",
                        boxShadow: "0 4px 24px rgba(0,0,0,0.22)",
                      }}
                    >
                      {EMOJI_CATEGORIES.map((cat) => (
                        <div key={cat.name}>
                          <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginTop: "0.5rem", marginBottom: "0.25rem" }}>
                            {cat.name}
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.1rem" }}>
                            {cat.emojis.map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => insertEmoji(emoji)}
                                style={{
                                  background: "none", border: "none", cursor: "pointer",
                                  fontSize: "1.25rem", lineHeight: 1, padding: "0.2rem 0.25rem",
                                  borderRadius: "var(--radius-sm)",
                                }}
                                title={emoji}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1.15rem", padding: "0.3rem 0.5rem" }}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={mediaFiles.length >= 4 || uploadingMedia}
                  title={t.compose_attach}
                >
                  {uploadingMedia ? "⏳" : "📎"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*,audio/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleFileChange}
                />
                {/* CW button */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: showCw ? "var(--accent-bg)" : undefined }}
                  onClick={() => setShowCw((v) => !v)}
                  title="Advertencia de contenido"
                >
                  ⚠️
                </button>
                {/* Poll button */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: pollMode ? "var(--accent-bg)" : undefined }}
                  onClick={() => setPollMode((v) => !v)}
                  disabled={mediaFiles.length > 0}
                  title="Encuesta"
                >
                  📊
                </button>
                {/* Visibility selector */}
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "0.8rem", padding: "0.3rem 0.4rem", cursor: "pointer", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", color: "var(--text)" }}
                  title={t.compose_visibility}
                >
                  <option value="public">🌍 {t.vis_public}</option>
                  <option value="unlisted">🔓 {t.vis_unlisted}</option>
                  <option value="followers">👥 {t.vis_followers}</option>
                  <option value="direct">📩 {t.vis_direct}</option>
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <span style={{ fontSize: "0.8rem", color: composing.length > 450 ? "var(--danger)" : "var(--text-muted)" }}>
                  {composing.length}/500
                </span>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={posting || (!composing.trim() && mediaFiles.length === 0 && !(pollMode && pollOptions.filter((o) => o.trim()).length >= 2))}
                >
                  {posting ? t.compose_posting : t.compose_post}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Timeline */}
        {loading ? (
          <div className="flex flex-col gap-0">
            {[1, 2, 3].map((i) => (
              <div key={i} className="status-card flex gap-3" style={{ padding: "1rem" }}>
                <div className="skeleton" style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }} />
                <div className="flex flex-col gap-2 flex-1">
                  <div className="skeleton" style={{ height: 14, width: "40%" }} />
                  <div className="skeleton" style={{ height: 14, width: "80%" }} />
                  <div className="skeleton" style={{ height: 14, width: "60%" }} />
                </div>
              </div>
            ))}
          </div>
        ) : statuses.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center"
            style={{ padding: "4rem 2rem", color: "var(--text-muted)", textAlign: "center" }}
          >
            <span style={{ fontSize: "3rem", marginBottom: "1rem" }}>🌐</span>
            <p>{t.timeline_empty}</p>
            <p style={{ fontSize: "0.875rem" }}>{t.timeline_empty_sub}</p>
          </div>
        ) : (
          statuses.map((s) => {
            const isRemote = s.account.acct.includes("@");
            const profileHref = isRemote
              ? `/users/remote?url=${encodeURIComponent(s.account.id)}`
              : `/users/${s.account.username}`;
            const threadHref = `/statuses/${encodeURIComponent(s.id)}`;
            return (
            <article key={s.id} className="status-card" style={{ display: "flex", gap: "0.875rem" }}>
              <Link href={profileHref}>
                <div
                  className="avatar"
                  style={{
                    width: 42, height: 42, flexShrink: 0,
                    background: "var(--accent-bg)", display: "flex",
                    alignItems: "center", justifyContent: "center", fontSize: "1.2rem",
                    borderRadius: "50%", overflow: "hidden",
                  }}
                >
                  {s.account.avatar && !s.account.avatar.endsWith("/default-avatar.png") ? (
                    <img
                      src={s.account.avatar}
                      alt={s.account.display_name || s.account.username}
                      style={{ width: 42, height: 42, objectFit: "cover" }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    (s.account.display_name?.[0] ?? s.account.username?.[0] ?? "?").toUpperCase()
                  )}
                </div>
              </Link>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-baseline gap-2" style={{ marginBottom: "0.3rem" }}>
                  <Link href={profileHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
                    {s.account.display_name || s.account.username}
                  </Link>
                  <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    @{s.account.acct}
                  </span>
                  <Link
                    href={threadHref}
                    style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "auto", textDecoration: "none" }}
                  >
                    {formatTime(s.created_at)}
                  </Link>
                </div>
                {s.spoiler_text && (
                  <div
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "0.375rem 0.625rem",
                      background: "var(--bg-elevated)",
                      borderRadius: "var(--radius-sm)",
                      fontSize: "0.875rem",
                      marginBottom: "0.4rem",
                      color: "var(--text-secondary)",
                      gap: "0.5rem",
                    }}
                  >
                    <span>⚠️ {s.spoiler_text}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", whiteSpace: "nowrap", flexShrink: 0 }}
                      onClick={() => setExpandedCw((prev) => {
                        const next = new Set(prev);
                        if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                        return next;
                      })}
                    >
                      {expandedCw.has(s.id) ? "Ocultar" : "Mostrar"}
                    </button>
                  </div>
                )}
                {(!s.spoiler_text || expandedCw.has(s.id)) && (
                  <div
                    style={{ fontSize: "0.95rem", lineHeight: 1.55, overflowWrap: "break-word", wordBreak: "break-word", minWidth: 0 }}
                    dangerouslySetInnerHTML={{ __html: s.content }}
                  />
                )}
                {(!s.spoiler_text || expandedCw.has(s.id)) && <MediaGrid attachments={s.media_attachments ?? []} />}
                {(!s.spoiler_text || expandedCw.has(s.id)) && s.poll && (
                  <PollView
                    poll={s.poll}
                    token={token}
                    onVoted={(updated) =>
                      setStatuses((prev) => prev.map((x) => x.id === s.id ? { ...x, poll: updated } : x))
                    }
                  />
                )}
                {s.edited_at && (
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.3rem" }}>
                    ✏️ editado
                  </div>
                )}
                <div className="flex gap-5 mt-3" style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                  <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }} onClick={() => setReplyTo(s)}>
                    💬 {s.replies_count}
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}>
                    🔁 {s.reblogs_count}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: "0.2rem 0.4rem", gap: "0.35rem", color: s.favourited ? "var(--danger)" : "var(--text-muted)" }}
                    onClick={() => toggleFavourite(s)}
                  >
                    {s.favourited ? "❤️" : "🤍"} {s.favourites_count}
                  </button>
                  {me && s.account.id === me.id && (
                    <>
                      <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", marginLeft: "auto" }} onClick={() => openEdit(s)} title="Editar">✏️</button>
                      <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", color: "var(--danger)" }} onClick={() => void handleDelete(s)} title="Eliminar">🗑️</button>
                    </>
                  )}
                </div>
              </div>
            </article>
            );
          })
        )}
        {/* Infinite scroll sentinel */}
        {!loading && statuses.length > 0 && (
          <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
            {loadingMore ? "Cargando más…" : hasMore ? "" : "No hay más estados"}
          </div>
        )}
      </main>

      {/* Reply compose modal */}
      {replyTo && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setReplyTo(null); setReplyText(""); setReplyMediaFiles([]); setReplyEmojiOpen(false); setReplyCw(false); setReplyCwText(""); setReplyPollMode(false); setReplyPollOptions(["", ""]); setReplyPollMultiple(false); } }}
        >
          <div style={{ background: "var(--bg)", borderRadius: "var(--radius-lg)", padding: "1.25rem", width: "min(520px, 95vw)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: "1rem" }}>Responder</span>
              <button type="button" onClick={() => { setReplyTo(null); setReplyText(""); setReplyMediaFiles([]); setReplyEmojiOpen(false); setReplyCw(false); setReplyCwText(""); setReplyPollMode(false); setReplyPollOptions(["", ""]); setReplyPollMultiple(false); }} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.1rem", padding: "0.25rem" }}>✕</button>
            </div>
            <div style={{ padding: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: "3px solid var(--border)" }}>
              <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--text)", marginBottom: "0.3rem" }}>
                {replyTo.account.display_name || replyTo.account.username}
              </div>
              <div
                style={{ fontSize: "0.87rem", color: "var(--text-secondary)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}
                dangerouslySetInnerHTML={{ __html: replyTo.content }}
              />
            </div>
            {replyCw && (
              <input
                type="text"
                className="input"
                placeholder="Advertencia de contenido…"
                value={replyCwText}
                onChange={(e) => setReplyCwText(e.target.value)}
                maxLength={200}
                style={{ fontSize: "0.9rem" }}
              />
            )}
            <textarea
              ref={replyTextareaRef}
              autoFocus
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Escribe tu respuesta…"
              maxLength={500}
              className="input"
              style={{ resize: "none", minHeight: 100, fontFamily: "inherit", width: "100%" }}
            />
            {replyPollMode && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", padding: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.25rem" }}>Opciones de la encuesta</div>
                {replyPollOptions.map((opt, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="text"
                      className="input"
                      placeholder={`Opción ${i + 1}`}
                      value={opt}
                      onChange={(e) => setReplyPollOptions((p) => p.map((o, j) => j === i ? e.target.value : o))}
                      maxLength={50}
                      style={{ flex: 1, fontSize: "0.875rem" }}
                    />
                    {replyPollOptions.length > 2 && (
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "0.25rem 0.4rem" }} onClick={() => setReplyPollOptions((p) => p.filter((_, j) => j !== i))}>✕</button>
                    )}
                  </div>
                ))}
                {replyPollOptions.length < 4 && (
                  <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", fontSize: "0.8rem" }} onClick={() => setReplyPollOptions((p) => [...p, ""])}>+ Añadir opción</button>
                )}
                <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                  <select value={replyPollExpiry} onChange={(e) => setReplyPollExpiry(Number(e.target.value))} className="btn btn-ghost btn-sm" style={{ fontSize: "0.78rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--text)" }}>
                    <option value={300}>5 minutos</option>
                    <option value={3600}>1 hora</option>
                    <option value={21600}>6 horas</option>
                    <option value={86400}>1 día</option>
                    <option value={259200}>3 días</option>
                    <option value={604800}>7 días</option>
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", cursor: "pointer" }}>
                    <input type="checkbox" checked={replyPollMultiple} onChange={(e) => setReplyPollMultiple(e.target.checked)} />
                    Opción múltiple
                  </label>
                </div>
              </div>
            )}
            {replyMediaFiles.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {replyMediaFiles.map((f) => (
                  <div key={f.id} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                    <div style={{ position: "relative", flexShrink: 0, width: 64, height: 64 }}>
                      {f.type === "image" || f.type === "gifv" ? (
                        <img src={f.preview_url ?? f.url} alt={f.description ?? ""} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: "var(--radius-sm)" }} />
                      ) : (
                        <div style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.4rem" }}>{f.type === "audio" ? "🎵" : "🎬"}</div>
                      )}
                      <button type="button" onClick={() => setReplyMediaFiles((prev) => prev.filter((x) => x.id !== f.id))} style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.65)", color: "#fff", border: "none", borderRadius: "50%", width: 16, height: 16, cursor: "pointer", fontSize: "0.6rem", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                    </div>
                    <input
                      type="text"
                      placeholder="Descripción (alt text)…"
                      defaultValue={f.description ?? ""}
                      maxLength={420}
                      onChange={(e) => { replyDescRefs.current[f.id] = e.target.value; }}
                      onBlur={(e) => void updateMediaDesc(f.id, e.target.value, setReplyMediaFiles)}
                      style={{ flex: 1, padding: "0.3rem 0.5rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: "0.8rem", fontFamily: "inherit" }}
                    />
                  </div>
                ))}
                {replyUploadingMedia && <div style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>⏳</div>}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                <div ref={replyEmojiRef} style={{ position: "relative" }}>
                  <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.1rem", padding: "0.25rem 0.4rem", background: replyEmojiOpen ? "var(--accent-bg)" : undefined }} onClick={() => setReplyEmojiOpen((o) => !o)} title="Emoji">😊</button>
                  {replyEmojiOpen && (
                    <div style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "0.75rem", zIndex: 200, width: 300, maxHeight: 240, overflowY: "auto", boxShadow: "0 4px 24px rgba(0,0,0,0.22)" }}>
                      {EMOJI_CATEGORIES.map((cat) => (
                        <div key={cat.name}>
                          <div style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginTop: "0.5rem", marginBottom: "0.25rem" }}>{cat.name}</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.1rem" }}>
                            {cat.emojis.map((emoji) => (
                              <button key={emoji} type="button" onClick={() => insertReplyEmoji(emoji)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: "0.2rem", borderRadius: "var(--radius-sm)" }} title={emoji}>{emoji}</button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.1rem", padding: "0.25rem 0.4rem" }} onClick={() => replyFileInputRef.current?.click()} disabled={replyMediaFiles.length >= 4 || replyUploadingMedia} title={t.compose_attach}>{replyUploadingMedia ? "⏳" : "📎"}</button>
                <input ref={replyFileInputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: "none" }} onChange={handleReplyFileChange} />
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1rem", padding: "0.25rem 0.4rem", background: replyCw ? "var(--accent-bg)" : undefined }} onClick={() => setReplyCw((v) => !v)} title="Advertencia de contenido">⚠️</button>
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1rem", padding: "0.25rem 0.4rem", background: replyPollMode ? "var(--accent-bg)" : undefined }} onClick={() => setReplyPollMode((v) => !v)} disabled={replyMediaFiles.length > 0} title="Encuesta">📊</button>
                <select value={replyVisibility} onChange={(e) => setReplyVisibility(e.target.value as typeof replyVisibility)} className="btn btn-ghost btn-sm" style={{ fontSize: "0.78rem", padding: "0.25rem 0.4rem", cursor: "pointer", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", color: "var(--text)" }} title={t.compose_visibility}>
                  <option value="public">🌍 {t.vis_public}</option>
                  <option value="unlisted">🔓 {t.vis_unlisted}</option>
                  <option value="followers">👥 {t.vis_followers}</option>
                  <option value="direct">📩 {t.vis_direct}</option>
                </select>
                <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{replyText.length}/500</span>
              </div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setReplyTo(null); setReplyText(""); setReplyMediaFiles([]); setReplyEmojiOpen(false); setReplyCw(false); setReplyCwText(""); setReplyPollMode(false); setReplyPollOptions(["", ""]); setReplyPollMultiple(false); }}>Cancelar</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={(!replyText.trim() && replyMediaFiles.length === 0 && !(replyPollMode && replyPollOptions.filter((o) => o.trim()).length >= 2)) || replyPosting} onClick={() => void handleReply()}>
                  {replyPosting ? "…" : "Responder"}
                </button>
              </div>
            </div>
          </div>
        </div>
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
    </div>
  );
}
