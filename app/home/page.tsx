"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { StatusCard } from "@/components/StatusCard";
import { EmojiPicker } from "@/components/EmojiPicker";
import { useEmojiAutocomplete, EmojiAutocompleteDropdown } from "@/components/EmojiAutocomplete";
import { BackToTop } from "@/components/BackToTop";
import { Icon } from "@/components/Icon";
import { VisibilityPicker } from "@/components/VisibilityPicker";
import { AnnouncementsBanner } from "@/components/AnnouncementsBanner";
import type { Status, Me, MediaAttachment } from "@/components/StatusCard";

// Earliest allowed schedule time: now + 5 minutes (computed once at module load)
const SCHEDULE_MIN = (() => {
  const d = new Date(Date.now() + 5 * 60 * 1000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
})();

export default function HomePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [composing, setComposing] = useState("");
  const [posting, setPosting] = useState(false);
  const [mediaFiles, setMediaFiles] = useState<MediaAttachment[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "unlisted" | "followers" | "direct">("public");
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpoiler, setEditSpoiler] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mediaDescRefs = useRef<Record<string, string>>({});
  const { t, locale } = useLocale();
  const emojiAuto = useEmojiAutocomplete(composing, setComposing, textareaRef);
  const editEmojiAuto = useEmojiAutocomplete(editText, setEditText, editTextareaRef);

  const fetchPage = useCallback(async (maxId?: string) => {
    const url = maxId ? `/api/v1/timelines/home?max_id=${encodeURIComponent(maxId)}` : "/api/v1/timelines/home";
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { items: [], hasMore: true };
    const items = await res.json() as Status[];
    return { items, hasMore: items.length >= 20 };
  }, []);

  const { statuses, setStatuses, loading, loadingMore, hasMore, seenIdsRef, loadMore, refresh, catchUp } = useTimelineCache("home", fetchPage, { refetchOnMount: true });

  // Real-time home feed streaming
  useTimelineStream("user", (event, payload) => {
    if (event === "update") {
      try {
        const status = JSON.parse(payload) as Status;
        if (seenIdsRef.current.has(status.id)) return;
        seenIdsRef.current.add(status.id);
        setStatuses((prev) => [status, ...prev]);
      } catch { /* ignore */ }
    } else if (event === "delete") {
      const deletedId = payload.replace(/^"|"$/g, "");
      seenIdsRef.current.delete(deletedId);
      setStatuses((prev) => prev.filter((s) => s.id !== deletedId));
    } else if (event === "status.update") {
      try {
        const updated = JSON.parse(payload) as Status;
        setStatuses((prev) => prev.map((s) => s.id === updated.id ? { ...s, ...updated } : s));
      } catch { /* ignore */ }
    }
  }, { onReconnect: () => { void catchUp(); } });

  // CW compose state
  const [showCw, setShowCw] = useState(false);
  const [cwText, setCwText] = useState("");
  // Poll compose state
  const [pollMode, setPollMode] = useState(false);
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollExpiry, setPollExpiry] = useState(86400);
  const [pollMultiple, setPollMultiple] = useState(false);
  // Scheduling state
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");

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

  const closeEmoji = useCallback(() => setEmojiOpen(false), []);

  async function fetchMe() {
    const res = await fetch("/api/v1/accounts/verify_credentials", { credentials: "include" });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchPrefs() {
    const res = await fetch("/api/v1/preferences", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json() as Record<string, string | boolean | null>;
    const vis = data["posting:default:visibility"];
    if (typeof vis === "string") setVisibility(vis as "public" | "unlisted" | "followers" | "direct");
    if (data["posting:default:sensitive"] === true) setShowCw(true);
  }

  useEffect(() => {
    Promise.resolve().then(() => void fetchMe());
    Promise.resolve().then(() => void fetchPrefs());
  }, []);

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    if (uploadingMedia) return;
    const hasPoll = pollMode && pollOptions.filter((o) => o.trim()).length >= 2;
    if (!composing.trim() && mediaFiles.length === 0 && !hasPoll) return;
    setPosting(true);
    setEmojiOpen(false);
    const body: Record<string, unknown> = {
      status: composing,
      media_ids: mediaFiles.map((f) => f.id),
      visibility,
      sensitive: showCw,
      spoiler_text: showCw ? cwText : "",
      language: locale,
    };
    if (scheduling && scheduledAt) {
      body.scheduled_at = new Date(scheduledAt).toISOString();
    }
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
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: desc.trim() || null }),
          });
        }
      }));
    }
    const res = await fetch("/api/v1/statuses", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      if (data && data.scheduled_at) {
        setPosting(false);
        router.push("/scheduled");
        return;
      }
      setComposing("");
      setMediaFiles([]);
      mediaDescRefs.current = {};
      setShowCw(false);
      setCwText("");
      setPollMode(false);
      setPollOptions(["", ""]);
      setPollMultiple(false);
      await refresh();
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
    if (!e.target.files?.length) return;
    const files = Array.from(e.target.files).slice(0, 4 - mediaFiles.length);
    e.target.value = "";
    setUploadingMedia(true);
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      form.append("locale", locale);
      // CW on → media blurred by default
      if (showCw) form.append("sensitive", "true");
      try {
        const res = await fetch("/api/v1/media", {
          method: "POST",
          credentials: "include",
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
    await fetch(`/api/v1/media/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: description.trim() || null }),
    });
    setter((prev) => prev.map((f) => f.id === id ? { ...f, description: description.trim() || null } : f));
  }

  async function toggleMediaSensitive(id: string) {
    const target = mediaFiles.find((f) => f.id === id);
    if (!target) return;
    const next = !target.sensitive;
    await fetch(`/api/v1/media/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensitive: next }),
    });
    setMediaFiles((prev) => prev.map((f) => f.id === id ? { ...f, sensitive: next } : f));
  }

  function handleFav(updated: Status) {
    setStatuses((prev) => prev.map((x) => x.id === updated.id ? { ...x, favourited: updated.favourited, favourites_count: updated.favourites_count } : x));
  }

  function handleReblog(updated: Status) {
    setStatuses((prev) => prev.map((x) => x.id === updated.id ? { ...x, reblogged: updated.reblogged, reblogs_count: updated.reblogs_count } : x));
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
    if (!editText.trim() || !editingStatus) return;
    setEditBusy(true);
    const res = await fetch(`/api/v1/statuses/${editingStatus.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
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
    if (!confirm("¿Eliminar este estado?")) return;
    const res = await fetch(`/api/v1/statuses/${s.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      setStatuses((prev) => prev.filter((x) => x.id !== s.id));
    }
  }

  return (
    <>
    <PageLayout sidebar={<Sidebar me={me} currentPath="/home" />}>

      {/* Main feed */}
        <AnnouncementsBanner />
        {/* Compose */}
        <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
          <form onSubmit={handlePost} className="flex flex-col gap-3">
            {/* CW input */}
            {showCw && (
              <input
                type="text"
                className="input"
                placeholder={`${t.cw_placeholder}…`}
                aria-label={t.cw_placeholder}
                value={cwText}
                onChange={(e) => setCwText(e.target.value)}
                maxLength={200}
                style={{ fontSize: "0.9rem" }}
              />
            )}
            {/* Textarea */}
            <div style={{ position: "relative" }}>
              <textarea
                ref={textareaRef}
                className="input"
                style={{ resize: "none", minHeight: 80, fontFamily: "inherit" }}
                placeholder={t.compose_placeholder}
                aria-label={t.compose_label}
                value={composing}
                onChange={emojiAuto.onChange}
                onKeyDown={emojiAuto.onKeyDown}
                maxLength={500}
              />
              <EmojiAutocompleteDropdown
                suggestions={emojiAuto.suggestions}
                activeIndex={emojiAuto.activeIndex}
                onSelect={emojiAuto.select}
              />
            </div>

            {/* Poll options */}
            {pollMode && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", padding: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.25rem" }}>{t.composer_poll_options}</div>
                {pollOptions.map((opt, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="text"
                      className="input"
                      placeholder={t.composer_poll_option.replace("{number}", String(i + 1))}
                      aria-label={t.composer_poll_option.replace("{number}", String(i + 1))}
                      value={opt}
                      onChange={(e) => setPollOptions((p) => p.map((o, j) => j === i ? e.target.value : o))}
                      maxLength={50}
                      style={{ flex: 1, fontSize: "0.875rem" }}
                    />
                    {pollOptions.length > 2 && (
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "0.25rem 0.4rem" }} onClick={() => setPollOptions((p) => p.filter((_, j) => j !== i))} aria-label={t.composer_poll_remove_option.replace("{number}", String(i + 1))}><Icon name="times" color="var(--danger)" /></button>
                    )}
                  </div>
                ))}
                {pollOptions.length < 4 && (
                  <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", fontSize: "0.8rem" }} onClick={() => setPollOptions((p) => [...p, ""])}>{t.composer_poll_add_option}</button>
                )}
                <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                  <select value={pollExpiry} onChange={(e) => setPollExpiry(Number(e.target.value))} className="btn btn-ghost btn-sm" style={{ fontSize: "0.78rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--text)" }}>
                    <option value={300}>{t.composer_poll_5m}</option>
                    <option value={3600}>{t.composer_poll_1h}</option>
                    <option value={21600}>{t.composer_poll_6h}</option>
                    <option value={86400}>{t.composer_poll_1d}</option>
                    <option value={259200}>{t.composer_poll_3d}</option>
                    <option value={604800}>{t.composer_poll_7d}</option>
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", cursor: "pointer" }}>
                    <input type="checkbox" checked={pollMultiple} onChange={(e) => setPollMultiple(e.target.checked)} />
                    {t.poll_multiple}
                  </label>
                </div>
              </div>
            )}

            {/* Schedule picker */}
            {scheduling && (
              <input
                type="datetime-local"
                className="input"
                aria-label={t.composer_schedule}
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                min={SCHEDULE_MIN}
                style={{ fontSize: "0.85rem", width: "100%" }}
              />
            )}

            {/* Media previews */}
            {mediaFiles.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {mediaFiles.map((f) => (
                  <div key={f.id} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                    <div style={{ position: "relative", flexShrink: 0, width: 72, height: 72 }}>
                      {f.type === "image" || f.type === "gifv" ? (
                        <Image src={f.preview_url ?? f.url} alt={f.description ?? ""} width={72} height={72} style={{ objectFit: "cover", borderRadius: "var(--radius-sm)", filter: f.sensitive ? "blur(8px)" : undefined }} />
                      ) : (
                        <div style={{ width: 72, height: 72, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem" }}><Icon name={f.type === "audio" ? "music" : "film"} size="1.5rem" /></div>
                      )}
                      <button type="button" onClick={() => setMediaFiles((prev) => prev.filter((x) => x.id !== f.id))}
                        aria-label={t.action_delete}
                        style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.65)", color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: "0.65rem", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="times" color="#fff" /></button>
                      <button
                        type="button"
                        onClick={() => void toggleMediaSensitive(f.id)}
                        aria-pressed={!!f.sensitive}
                        title={t.media_sensitive_toggle}
                        style={{ position: "absolute", bottom: 2, left: 2, background: "rgba(0,0,0,0.65)", color: f.sensitive ? "var(--warning)" : "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: "0.65rem", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name={f.sensitive ? "eye-slash" : "eye"} color={f.sensitive ? "var(--warning)" : "#fff"} /></button>
                    </div>
                    <input
                      type="text"
                      placeholder={`${t.media_alt_text}…`}
                      aria-label={t.media_alt_text}
                      defaultValue={f.description ?? ""}
                      maxLength={420}
                      onChange={(e) => { mediaDescRefs.current[f.id] = e.target.value; }}
                      onBlur={(e) => void updateMediaDesc(f.id, e.target.value, setMediaFiles)}
                      style={{ flex: 1, padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: "0.82rem", fontFamily: "inherit" }}
                    />
                  </div>
                ))}
                {uploadingMedia && (
                  <div style={{ width: 72, height: 72, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem" }}><Icon name="hourglass" spin size="1.5rem" /></div>
                )}
              </div>
            )}

            {/* Toolbar + counter + submit */}
            <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
              <div style={{ display: "flex", gap: "0.25rem", alignItems: "center", position: "relative", flexWrap: "wrap" }}>
                {/* Emoji button + picker */}
                <div ref={emojiRef} style={{ position: "relative" }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: "1.15rem", padding: "0.3rem 0.5rem", background: emojiOpen ? "var(--accent-bg)" : undefined }}
                    onClick={() => setEmojiOpen((o) => !o)}
                    title={t.composer_emoji}
                    aria-label={t.composer_emoji}
                    aria-haspopup="dialog"
                    aria-expanded={emojiOpen}
                  >
                    <Icon name="smile-o" size="1.15rem" />
                  </button>
                  <EmojiPicker
                    onInsert={insertEmoji}
                    open={emojiOpen}
                    onClose={closeEmoji}
                    anchorRef={emojiRef}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1.15rem", padding: "0.3rem 0.5rem" }}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={mediaFiles.length >= 4 || uploadingMedia}
                  title={t.compose_attach}
                  aria-label={t.compose_attach}
                >
                  {uploadingMedia ? <Icon name="hourglass" spin size="1.15rem" /> : <Icon name="paperclip" size="1.15rem" />}
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
                  title={t.cw_placeholder}
                  aria-label={t.cw_placeholder}
                  aria-pressed={showCw}
                >
                  <Icon name="exclamation-triangle" size="1rem" />
                </button>
                {/* Poll button */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: pollMode ? "var(--accent-bg)" : undefined }}
                  onClick={() => setPollMode((v) => !v)}
                  disabled={mediaFiles.length > 0}
                  title={t.composer_poll}
                  aria-label={t.composer_poll}
                  aria-pressed={pollMode}
                >
                  <Icon name="bar-chart" size="1rem" />
                </button>
                {/* Schedule button */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: scheduling ? "var(--accent-bg)" : undefined }}
                  onClick={() => setScheduling((v) => !v)}
                  title={t.composer_schedule}
                  aria-label={t.composer_schedule}
                  aria-pressed={scheduling}
                >
                  <Icon name="clock-o" size="1rem" />
                </button>
                {/* Visibility selector */}
                <VisibilityPicker value={visibility} onChange={(v) => setVisibility(v)} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <span style={{ fontSize: "0.8rem", color: composing.length > 450 ? "var(--danger)" : "var(--text-muted)" }}>
                  {composing.length}/500
                </span>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={posting || uploadingMedia || (!composing.trim() && mediaFiles.length === 0 && !(pollMode && pollOptions.filter((o) => o.trim()).length >= 2))}
                >
                  {posting ? t.compose_posting : uploadingMedia ? <Icon name="hourglass" spin color="#fff" /> : t.compose_post}
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
            <span style={{ fontSize: "3rem", marginBottom: "1rem" }}><Icon name="globe" size="3rem" /></span>
            <p>{t.timeline_empty}</p>
            <p style={{ fontSize: "0.875rem" }}>{t.timeline_empty_sub}</p>
          </div>
        ) : (
          statuses.map((s) => (
            <div key={s.id} data-status-id={s.id}>
              <StatusCard
                  status={s}
                  onFav={handleFav}
                  onReblog={handleReblog}
                  onReply={(status) => router.push(`/statuses/${encodeURIComponent(status.id)}?reply=1`)}
                  me={me}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                />
            </div>
          ))
        )}
        {/* Infinite scroll sentinel */}
        {!loading && statuses.length > 0 && (
          <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
            {loadingMore ? "Cargando más…" : hasMore ? "" : "No hay más estados"}
          </div>
        )}
      </PageLayout>

      <BackToTop />
      {/* Edit status modal */}
      {editingStatus && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t.edit_status_title}
          style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditingStatus(null); }}
        >
          <div style={{ background: "var(--bg)", borderRadius: "var(--radius-lg)", padding: "1.25rem", width: "min(520px, 95vw)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: "1rem" }}>{t.edit_status_title}</span>
              <button type="button" onClick={() => setEditingStatus(null)} aria-label={t.action_close} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.1rem", padding: "0.25rem" }}><Icon name="times" color="var(--text-muted)" /></button>
            </div>
            {editSpoiler !== "" || editingStatus.spoiler_text ? (
              <input
                type="text"
                value={editSpoiler}
                onChange={(e) => setEditSpoiler(e.target.value)}
                placeholder={t.cw_placeholder}
                aria-label={t.cw_placeholder}
                className="input"
                style={{ width: "100%" }}
              />
            ) : null}
            <div style={{ position: "relative" }}>
              <textarea
                autoFocus
                ref={editTextareaRef}
                value={editText}
                onChange={editEmojiAuto.onChange}
                onKeyDown={editEmojiAuto.onKeyDown}
                placeholder={t.edit_status_placeholder}
                aria-label={t.edit_label}
                maxLength={500}
                className="input"
                style={{ resize: "none", minHeight: 120, fontFamily: "inherit", width: "100%" }}
              />
              <EmojiAutocompleteDropdown
                suggestions={editEmojiAuto.suggestions}
                activeIndex={editEmojiAuto.activeIndex}
                onSelect={editEmojiAuto.select}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{editText.length}/500</span>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingStatus(null)}>{t.profile_cancel}</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={!editText.trim() || editBusy} onClick={() => void handleEditSave()}>
                  {editBusy ? "…" : t.profile_save}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
