"use client";

import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from "react";
import Image from "next/image";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { EmojiPicker } from "@/components/EmojiPicker";
import { useEmojiAutocomplete, EmojiAutocompleteDropdown } from "@/components/EmojiAutocomplete";
import { StatusCard } from "@/components/StatusCard";
import { RichText } from "@/components/RichText";
import { Icon } from "@/components/Icon";
import { EditStatusModal } from "@/components/EditStatusModal";
import { VisibilityPicker } from "@/components/VisibilityPicker";
import type { APMeta } from "@/components/APTypeBlock";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { purgeStatusFromCache } from "@/lib/streaming/timeline-cache";

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
  emojis?: EmojiData[];
}

interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface Mention {
  id: string;
  username: string;
  url: string;
  acct: string;
}

interface MediaAttachment {
  id: string;
  type: string;
  url: string;
  preview_url: string | null;
  description: string | null;
  blurhash?: string | null;
  sensitive?: boolean;
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
  edited_at?: string | null;
  in_reply_to_id?: string | null;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
  sensitive: boolean;
  spoiler_text: string;
  media_attachments: MediaAttachment[];
  visibility?: string;
  language?: string | null;
  poll: Poll | null;
  emojis?: EmojiData[];
  mentions?: Mention[];
  ap_type?: string | null;
  ap_meta?: APMeta | null;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface StatusEdit {
  content: string;
  spoiler_text: string;
  sensitive: boolean;
  created_at: string;
  account: Account;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Reply compose box ─────────────────────────────────────────────────────────

function ReplyBox({
  replyTo,
  me,
  onCancel,
  onPosted,
}: {
  replyTo: Status;
  me: Me | null;
  onCancel: () => void;
  onPosted: (newStatus: Status) => void;
}) {
  const token = getToken();
  const { t, locale } = useLocale();
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState<"public" | "unlisted" | "followers" | "direct">(
    (["public", "unlisted", "followers", "direct"].includes(replyTo.visibility ?? "public") ? replyTo.visibility ?? "public" : "public") as "public" | "unlisted" | "followers" | "direct"
  );
  const [mediaFiles, setMediaFiles] = useState<MediaAttachment[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCw, setShowCw] = useState(false);
  const [defaultSensitive, setDefaultSensitive] = useState(false);
  const [cwText, setCwText] = useState("");
  const [pollMode, setPollMode] = useState(false);
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollExpiry, setPollExpiry] = useState(86400);
  const [pollMultiple, setPollMultiple] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const descRefs = useRef<Record<string, string>>({});
  const prefilled = useRef(false);

  // A reply pre-fills the accounts related to the replied-to status (the author
  // plus everyone mentioned in it), each with its full domain
  // (@alice@remote.example), so the mentions resolve to the real accounts and
  // the whole conversation gets notified — Mastodon's "reply to all". Accounts
  // are scoped to `replyTo` (not the whole thread) so switching reply targets
  // never reuses handles from a previous status.
  const relatedHandles = useMemo(() => {
    const parts: string[] = [];
    const seen = new Set<string>();
    const add = (acct: string | undefined) => {
      if (!acct) return;
      const key = acct.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      parts.push(`@${acct}`);
    };
    if (replyTo.account && replyTo.account.id !== me?.id) {
      add(replyTo.account.acct);
    }
    for (const m of replyTo.mentions ?? []) {
      if (m.id === me?.id) continue;
      if (m.acct === replyTo.account?.acct) continue;
      add(m.acct);
    }
    return parts.join(" ");
  }, [replyTo, me]);

  // Pre-fill the handles exactly once, as soon as they are available. Only mark
  // the box as pre-filled once a non-empty handle list has actually been
  // inserted, so a late-loading thread still gets its handles.
  useEffect(() => {
    if (!me) return;
    if (prefilled.current) return;
    if (relatedHandles && !text) {
      prefilled.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(`${relatedHandles} `);
    }
  }, [me, relatedHandles, text]);
  const closeEmoji = useCallback(() => setEmojiOpen(false), []);
  const emojiAuto = useEmojiAutocomplete(text, setText, textareaRef);

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
      form.append("locale", locale);
      // CW on, or the "mark media as sensitive" preference → media blurred by default
      if (showCw || defaultSensitive) form.append("sensitive", "true");
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

  async function toggleMediaSensitive(id: string) {
    const target = mediaFiles.find((f) => f.id === id);
    if (!target) return;
    const next = !target.sensitive;
    await fetch(`/api/v1/media/${id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sensitive: next }),
    });
    setMediaFiles((prev) => prev.map((f) => f.id === id ? { ...f, sensitive: next } : f));
  }

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Mastodon: "always mark media as sensitive" → new attachments blur by default.
  useEffect(() => {
    if (!token) return;
    fetch("/api/v1/preferences", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() as Promise<Record<string, string | boolean | null>> : null))
      .then((data) => {
        if (data?.["posting:default:sensitive"] === true) setDefaultSensitive(true);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (uploadingMedia) return;
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
        {t.reply_to} <strong>@{replyTo.account.acct}</strong>
      </div>
      <div style={{ display: "flex", gap: "0.75rem" }}>
        {me && (
          <div style={{ width: 36, height: 36, position: "relative", flexShrink: 0, borderRadius: "50%", overflow: "hidden", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "var(--accent)", fontSize: "0.9rem" }}>
            {me.avatar
              ? <Image src={me.avatar} alt="" fill sizes="36px" style={{ objectFit: "cover" }} />
              : (me.display_name?.[0] ?? me.username?.[0] ?? "?").toUpperCase()}
          </div>
        )}
        <form onSubmit={handleSubmit} style={{ flex: 1 }}>
          {showCw && (
            <input
              type="text"
              value={cwText}
              onChange={(e) => setCwText(e.target.value)}
              placeholder={`${t.cw_placeholder}…`}
              aria-label={t.cw_placeholder}
              maxLength={500}
              style={{ width: "100%", marginBottom: "0.4rem", padding: "0.4rem 0.75rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: "0.9rem", fontFamily: "inherit" }}
            />
          )}
          <div style={{ position: "relative" }}>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={emojiAuto.onChange}
              onKeyDown={emojiAuto.onKeyDown}
              placeholder={t.reply_placeholder}
              aria-label={t.reply_placeholder}
              rows={3}
              style={{ width: "100%", resize: "vertical", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: "0.95rem", fontFamily: "inherit" }}
            />
            <EmojiAutocompleteDropdown
              suggestions={emojiAuto.suggestions}
              activeIndex={emojiAuto.activeIndex}
              onSelect={emojiAuto.select}
            />
          </div>
          {pollMode && (
            <div style={{ marginTop: "0.5rem", padding: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--bg)" }}>
              <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", marginBottom: "0.5rem" }}>Opciones de la encuesta</div>
              {pollOptions.map((opt, i) => (
                <div key={i} style={{ display: "flex", gap: "0.4rem", marginBottom: "0.35rem" }}>
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) => setPollOptions((p) => p.map((o, j) => j === i ? e.target.value : o))}
                    placeholder={t.composer_poll_option.replace("{number}", String(i + 1))}
                    aria-label={t.composer_poll_option.replace("{number}", String(i + 1))}
                    maxLength={50}
                    style={{ flex: 1, padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: "0.875rem" }}
                  />
                  {pollOptions.length > 2 && (
                    <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "0.2rem 0.4rem" }} onClick={() => setPollOptions((p) => p.filter((_, j) => j !== i))} aria-label={t.composer_poll_remove_option.replace("{number}", String(i + 1))}><Icon name="times" color="var(--danger)" /></button>
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
                  {t.poll_multiple}
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
                      <Image src={f.preview_url ?? f.url} alt={f.description ?? ""} width={64} height={64} style={{ objectFit: "cover", borderRadius: "var(--radius-sm)", filter: f.sensitive ? "blur(8px)" : undefined }} />
                    ) : (
                      <div style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.4rem" }}><Icon name={f.type === "audio" ? "music" : "film"} size="1.4rem" /></div>
                    )}
                    <button type="button" onClick={() => setMediaFiles((prev) => prev.filter((x) => x.id !== f.id))} aria-label={t.action_delete} style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.65)", color: "#fff", border: "none", borderRadius: "50%", width: 16, height: 16, cursor: "pointer", fontSize: "0.6rem", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="times" color="#fff" /></button>
                    <button
                      type="button"
                      onClick={() => void toggleMediaSensitive(f.id)}
                      aria-pressed={!!f.sensitive}
                      title={t.media_sensitive_toggle}
                      style={{ position: "absolute", bottom: 2, left: 2, background: "rgba(0,0,0,0.65)", color: f.sensitive ? "var(--warning)" : "#fff", border: "none", borderRadius: "50%", width: 16, height: 16, cursor: "pointer", fontSize: "0.6rem", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name={f.sensitive ? "eye-slash" : "eye"} color={f.sensitive ? "var(--warning)" : "#fff"} /></button>
                  </div>
                  <input
                    type="text"
                      placeholder={`${t.media_alt_text}…`}
                      aria-label={t.media_alt_text}
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
              {uploadingMedia && <div style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="hourglass" spin /></div>}
            </div>
          )}
          {error && <div style={{ color: "var(--danger)", fontSize: "0.82rem", marginTop: "0.25rem" }}>{error}</div>}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
              <div ref={emojiRef} style={{ position: "relative" }}>
                <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.05rem", padding: "0.2rem 0.35rem", background: emojiOpen ? "var(--accent-bg)" : undefined }} onClick={() => setEmojiOpen((o) => !o)} title={t.composer_emoji} aria-label={t.composer_emoji} aria-haspopup="dialog" aria-expanded={emojiOpen}><Icon name="smile-o" size="1.05rem" /></button>
                <EmojiPicker
                  onInsert={insertEmoji}
                  open={emojiOpen}
                  onClose={closeEmoji}
                  anchorRef={emojiRef}
                  direction="up"
                />
              </div>
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.05rem", padding: "0.2rem 0.35rem" }} onClick={() => fileInputRef.current?.click()} disabled={mediaFiles.length >= 4 || uploadingMedia || pollMode} title={t.composer_attach} aria-label={t.composer_attach}>{uploadingMedia ? <Icon name="hourglass" spin size="1.05rem" /> : <Icon name="paperclip" size="1.05rem" />}</button>
              <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: "none" }} onChange={handleFileChange} />
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.05rem", padding: "0.2rem 0.35rem", background: showCw ? "var(--accent-bg)" : undefined }} onClick={() => setShowCw((v) => !v)} title={t.cw_placeholder} aria-label={t.cw_placeholder} aria-pressed={showCw}><Icon name="exclamation-triangle" size="1.05rem" /></button>
              <button type="button" className="btn btn-ghost btn-sm" style={{ fontSize: "1.05rem", padding: "0.2rem 0.35rem", background: pollMode ? "var(--accent-bg)" : undefined }} onClick={() => setPollMode((v) => !v)} disabled={mediaFiles.length > 0} title={t.composer_poll} aria-label={t.composer_poll} aria-pressed={pollMode}><Icon name="bar-chart" size="1.05rem" /></button>
              <VisibilityPicker value={visibility} onChange={(v) => setVisibility(v)} direction="up" />
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={submitting}>
                {t.profile_cancel}
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={submitting || uploadingMedia || (!text.trim() && mediaFiles.length === 0 && !pollMode)}>
                {submitting ? t.compose_posting : uploadingMedia ? <Icon name="hourglass" spin /> : t.reply_button}
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
  const { t } = useLocale();
  const rawId = typeof params.id === "string" ? params.id : Array.isArray(params.id) ? params.id[0] : "";
  const statusId = decodeURIComponent(rawId);

  const [me, setMe] = useState<Me | null>(null);
  const [focal, setFocal] = useState<Status | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [ancestors, setAncestors] = useState<Status[]>([]);
  const [descendants, setDescendants] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyTarget, setReplyTarget] = useState<Status | null>(null);
  const [autoReply, setAutoReply] = useState(false);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [history, setHistory] = useState<StatusEdit[]>([]);
  const [historyTab, setHistoryTab] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const searchParams = useSearchParams();
  const token = getToken();

  useEffect(() => {
    Promise.resolve().then(() => {
      if (searchParams.get("reply") === "1") {
        setAutoReply(true);
        router.replace(`/statuses/${encodeURIComponent(statusId)}`, { scroll: false });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    Promise.resolve().then(() => {
      if (autoReply && focal) {
        setReplyTarget(focal);
        setAutoReply(false);
      }
    });
  }, [autoReply, focal]);

  useEffect(() => {
    Promise.resolve().then(() => {
      if (focal && !focal.edited_at) setHistoryTab(false);
    });
  }, [focal]);

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

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    Promise.resolve().then(() => {
      void load();
      void fetchMe();
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusId]);

  // Remove the status from the screen live when it's deleted (streaming delete
  // events carry the encoded status id), and purge it from any cached timelines.
  useTimelineStream("public", (event, payload) => {
    if (event !== "delete") return;
    const deletedId = payload.replace(/^"|"$/g, "");
    purgeStatusFromCache(deletedId);
    if (deletedId === statusId) setDeleted(true);
  });

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

  async function loadHistory() {
    if (history.length > 0 || historyLoading) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/v1/statuses/${encodeURIComponent(statusId)}/history`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) setHistory(await res.json() as StatusEdit[]);
    } catch {
      // silently fail
    }
    setHistoryLoading(false);
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
    setEditingStatus(s);
  }

  function handleStatusSaved(updated: Status) {
    const updateList = (prev: Status[]) => prev.map((x) => (x.id === updated.id ? updated : x));
    setFocal((f) => (f?.id === updated.id ? updated : f));
    setAncestors(updateList);
    setDescendants(updateList);
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="" />}>
        {/* Back header with tabs */}
        <div
          style={{
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            borderBottom: "1px solid var(--border)",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "0.75rem 1rem" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => router.back()}
              style={{ fontSize: "1.1rem" }}
            >
              <Icon name="arrow-left" />
            </button>
            <span style={{ fontWeight: 600 }}>Post</span>
          </div>
          <div className="flex" style={{ borderTop: "1px solid var(--border)" }}>
            <button
              className="btn btn-ghost"
              onClick={() => setHistoryTab(false)}
              style={{
                flex: 1, borderRadius: 0, padding: "0.625rem 1rem",
                borderBottom: !historyTab ? "2px solid var(--accent)" : "2px solid transparent",
                color: !historyTab ? "var(--accent)" : "var(--text-muted)",
                fontWeight: !historyTab ? 600 : 400,
                fontSize: "0.875rem",
              }}
            >
              Hilo
            </button>
            {focal?.edited_at && (
              <button
                className="btn btn-ghost"
                onClick={() => { setHistoryTab(true); void loadHistory(); }}
                style={{
                  flex: 1, borderRadius: 0, padding: "0.625rem 1rem",
                  borderBottom: historyTab ? "2px solid var(--accent)" : "2px solid transparent",
                  color: historyTab ? "var(--accent)" : "var(--text-muted)",
                  fontWeight: historyTab ? 600 : 400,
                  fontSize: "0.875rem",
                }}
              >
                Historial de edición
              </button>
            )}
          </div>
        </div>

        {historyTab ? (
          historyLoading ? (
            <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
              Loading history...
            </div>
          ) : history.length === 0 ? (
            <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
              <span style={{ fontSize: "2rem", display: "block", marginBottom: "0.75rem" }}><Icon name="pencil" size="2rem" /></span>
              No hay historial de ediciones.
            </div>
          ) : (
            history.map((edit, i) => (
              <div key={i} style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                  Edición del {new Date(edit.created_at).toLocaleString()}
                </div>
                {edit.spoiler_text && (
                  <div style={{ padding: "0.375rem 0.625rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", fontSize: "0.875rem", marginBottom: "0.4rem", color: "var(--text-secondary)" }}>
                    <Icon name="exclamation-triangle" size="0.875rem" /> {edit.spoiler_text}
                  </div>
                )}
                <div className="status-content" style={{ fontSize: "0.95rem", lineHeight: 1.6 }}>
                  <RichText html={edit.content} />
                </div>
              </div>
            ))
          )
        ) : loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            Loading thread...
          </div>
        ) : deleted || !focal ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            {deleted ? t.status_deleted : t.profile_not_found}
          </div>
        ) : (
          <>
            {/* Ancestors */}
            {ancestors.map((s) => (
              <Fragment key={s.id}>
                <StatusCard status={s} onFav={handleFav} onReblog={handleReblog} onReply={handleReply} me={me} onDelete={handleDelete} onEdit={openEdit} />
                {replyTarget?.id === s.id && (
                  <ReplyBox key={`reply-${s.id}`} replyTo={s} me={me} onCancel={() => setReplyTarget(null)} onPosted={handlePosted} />
                )}
              </Fragment>
            ))}

            {/* Focal status (highlighted) */}
            <StatusCard status={focal} isFocal onFav={handleFav} onReblog={handleReblog} onReply={handleReply} me={me} onDelete={handleDelete} onEdit={openEdit} />
            {replyTarget?.id === focal.id && (
              <div ref={replyRef}>
                <ReplyBox replyTo={focal} me={me} onCancel={() => setReplyTarget(null)} onPosted={handlePosted} />
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
              <Fragment key={s.id}>
                <StatusCard status={s} onFav={handleFav} onReblog={handleReblog} onReply={handleReply} me={me} onDelete={handleDelete} onEdit={openEdit} />
                {replyTarget?.id === s.id && (
                  <ReplyBox key={`reply-${s.id}`} replyTo={s} me={me} onCancel={() => setReplyTarget(null)} onPosted={handlePosted} />
                )}
              </Fragment>
            ))}
          </>
        )}

        {/* Edit status modal */}
        <EditStatusModal status={editingStatus} onClose={() => setEditingStatus(null)} onSaved={handleStatusSaved} />
      </PageLayout>
  );
}
