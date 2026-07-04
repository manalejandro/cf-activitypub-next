"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { StatusCard, Status, Me } from "@/components/StatusCard";

type TimelineView = "local" | "federated";

export default function TimelinesPage() {
  const [view, setView] = useState<TimelineView>("local");
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpoiler, setEditSpoiler] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const { t } = useLocale();

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const router = useRouter();
  const viewRef = useRef<TimelineView>("local");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Streaming: subscribe to the correct channel whenever the view changes
  const streamName = view === "local" ? "public:local" : "public";
  useTimelineStream(streamName, null, (event, payload) => {
    if (event === "update") {
      try {
        const status = JSON.parse(payload) as Status;
        if (seenIdsRef.current.has(status.id)) return;
        seenIdsRef.current.add(status.id);
        setStatuses((prev) => [status, ...prev]);
      } catch { /* ignore malformed payload */ }
    } else if (event === "delete") {
      const deletedId = payload.replace(/^"|"$/g, ""); // payload is a plain string ID
      seenIdsRef.current.delete(deletedId);
      setStatuses((prev) => prev.filter((s) => s.id !== deletedId));
    } else if (event === "status.update") {
      try {
        const updated = JSON.parse(payload) as Status;
        setStatuses((prev) => prev.map((s) => s.id === updated.id ? { ...s, ...updated } : s));
      } catch { /* ignore */ }
    }
  });

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchTimeline(v: TimelineView) {
    setLoading(true);
    setStatuses([]);
    setHasMore(true);
    seenIdsRef.current = new Set();
    const local = v === "local";
    const res = await fetch(`/api/v1/timelines/public?limit=40${local ? "&local=true" : ""}`);
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses(data);
      // Pre-fill the seen set so streaming duplicates are filtered out
      for (const s of data) seenIdsRef.current.add(s.id);
    }
    setLoading(false);
  }

  async function loadMore() {
    if (loadingMore || statuses.length === 0 || !hasMore) return;
    setLoadingMore(true);
    const lastId = statuses[statuses.length - 1].id;
    const local = view === "local";
    const res = await fetch(
      `/api/v1/timelines/public?max_id=${encodeURIComponent(lastId)}&limit=20${local ? "&local=true" : ""}`
    );
    if (res.ok) {
      const more = await res.json() as Status[];
      if (more.length === 0) {
        setHasMore(false);
      } else {
        setStatuses((prev) => [...prev, ...more]);
      }
    }
    setLoadingMore(false);
  }

  function switchView(v: TimelineView) {
    setView(v);
  }

  function handleFav(updated: Status) {
    setStatuses((prev) => prev.map((x) => x.id === updated.id ? { ...x, favourited: updated.favourited, favourites_count: updated.favourites_count } : x));
  }

  function handleReblog(updated: Status) {
    setStatuses((prev) => prev.map((x) => x.id === updated.id ? { ...x, reblogged: updated.reblogged, reblogs_count: updated.reblogs_count } : x));
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
      setStatuses((prev) => prev.map((x) => (x.id === editingStatus.id ? updated : x)));
      setEditingStatus(null);
    }
    setEditBusy(false);
  }

  async function handleDelete(s: Status) {
    if (!token) return;
    if (!confirm("¿Eliminar este estado?")) return;
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(s.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) => prev.filter((x) => x.id !== s.id));
    }
  }

  // Mount: initial load
  useEffect(() => {
    void fetchTimeline("local");
    void fetchMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // View change: reload timeline
  useEffect(() => {
    viewRef.current = view;
    void fetchTimeline(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Infinite scroll sentinel
  useEffect(() => {
    if (!bottomRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void loadMore();
      },
      { threshold: 0.1 }
    );
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, loadingMore, hasMore]);

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/timelines" />

      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Sticky header with tabs */}
        <div
          style={{
            padding: "0.875rem 1rem 0",
            borderBottom: "1px solid var(--border)",
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            zIndex: 10,
          }}
        >
          <h1 style={{ fontWeight: 700, fontSize: "1.2rem", marginBottom: "0.75rem" }}>
            {t.nav_timelines}
          </h1>
          <div style={{ display: "flex" }}>
            {(["local", "federated"] as TimelineView[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => switchView(v)}
                className="btn btn-ghost"
                style={{
                  flex: 1,
                  borderRadius: 0,
                  padding: "0.6rem 1rem",
                  borderBottom: view === v ? "2px solid var(--accent)" : "2px solid transparent",
                  color: view === v ? "var(--accent)" : "var(--text-muted)",
                  fontWeight: view === v ? 600 : 400,
                }}
              >
                {v === "local" ? `🏘️ ${t.timeline_local}` : `🌐 ${t.timeline_federated}`}
              </button>
            ))}
          </div>
        </div>



        {/* Loading skeletons */}
        {loading && (
          <div>
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: "0.875rem",
                  padding: "1rem",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div
                  className="skeleton"
                  style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }}
                />
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <div className="skeleton" style={{ height: 13, width: "40%" }} />
                  <div className="skeleton" style={{ height: 13, width: "80%" }} />
                  <div className="skeleton" style={{ height: 13, width: "60%" }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && statuses.length === 0 && (
          <div style={{ padding: "3rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
            <span style={{ fontSize: "2.5rem", display: "block", marginBottom: "0.75rem" }}>
              {view === "local" ? "🏘️" : "🌐"}
            </span>
            <p style={{ fontWeight: 600 }}>
              {view === "local" ? t.timeline_public_empty : t.timeline_federated_empty}
            </p>
          </div>
        )}

        {/* Status list */}
        {!loading && statuses.length > 0 && (
          <div>
            {statuses.map((s) => (
              <StatusCard
                key={s.id}
                status={s}
                token={token}
                onFav={handleFav}
                onReblog={handleReblog}
                onReply={(status) => router.push(`/statuses/${encodeURIComponent(status.id)}?reply=1`)}
                me={me ?? undefined}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            ))}
            <div ref={bottomRef} style={{ height: 1 }} />
            {loadingMore && (
              <div
                style={{
                  padding: "1rem",
                  textAlign: "center",
                  color: "var(--text-muted)",
                  fontSize: "0.875rem",
                }}
              >
                {t.loading}
              </div>
            )}
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

      {/* Right panel — join CTA if not logged in */}
      {!token && (
        <div className="hidden lg:block" style={{ width: 300, padding: "1.5rem 1rem" }}>
          <div
            style={{
              background: "var(--bg-elevated)",
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--border)",
              padding: "1rem",
            }}
          >
            <h3 style={{ fontWeight: 700, marginBottom: "0.75rem", fontSize: "0.95rem" }}>
              {t.explore_join}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <Link
                href="/register"
                className="btn btn-primary btn-sm"
                style={{ textAlign: "center" }}
              >
                {t.explore_create}
              </Link>
              <Link
                href="/login"
                className="btn btn-ghost btn-sm"
                style={{ textAlign: "center" }}
              >
                {t.explore_signin}
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
