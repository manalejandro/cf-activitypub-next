"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { StatusCard } from "@/components/StatusCard";
import { EmojiPicker } from "@/components/EmojiPicker";
import type { Status, Me, MediaAttachment } from "@/components/StatusCard";

export default function HomePage() {
  const router = useRouter();
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mediaDescRefs = useRef<Record<string, string>>({});
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const seenIdsRef = useRef<Set<string>>(new Set());
  const { t, locale } = useLocale();

  // Real-time home feed streaming
  useTimelineStream("user", token, (event, payload) => {
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
  }, { enabled: !!token });

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
    if (res.ok) setMe(await res.json() as Me);
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
      const data = await res.json() as Record<string, unknown>;
      if (data && data.scheduled_at) {
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
      form.append("locale", locale);
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

            {/* Schedule picker */}
            {scheduling && (
              <input
                type="datetime-local"
                className="input"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                min={(() => { const d = new Date(Date.now() + 5 * 60 * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); })()}
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
            <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
              <div style={{ display: "flex", gap: "0.25rem", alignItems: "center", position: "relative", flexWrap: "wrap" }}>
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
                {/* Schedule button */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: scheduling ? "var(--accent-bg)" : undefined }}
                  onClick={() => setScheduling((v) => !v)}
                  title="Programar"
                >
                  🕐
                </button>
                {/* Visibility selector */}
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "0.8rem", padding: "0.3rem 0.4rem", cursor: "pointer", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", color: "var(--text)", maxWidth: "7rem" }}
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
          statuses.map((s) => (
            <StatusCard
              key={s.id}
              status={s}
              token={token}
              onFav={handleFav}
              onReblog={handleReblog}
              onReply={(status) => router.push(`/statuses/${encodeURIComponent(status.id)}?reply=1`)}
              me={me}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          ))
        )}
        {/* Infinite scroll sentinel */}
        {!loading && statuses.length > 0 && (
          <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
            {loadingMore ? "Cargando más…" : hasMore ? "" : "No hay más estados"}
          </div>
        )}
      </main>


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
