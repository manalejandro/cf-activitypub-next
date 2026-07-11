"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { StatusCard, Status, Me } from "@/components/StatusCard";

export default function HashtagPage() {
  const params = useParams();
  const hashtag = typeof params.hashtag === "string" ? params.hashtag : "";

  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpoiler, setEditSpoiler] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const { t } = useLocale();

  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Real-time hashtag streaming
  useTimelineStream("hashtag", null, (event, payload) => {
    if (event !== "update") return;
    try {
      const status = JSON.parse(payload) as Status;
      if (seenIdsRef.current.has(status.id)) return;
      seenIdsRef.current.add(status.id);
      setStatuses((prev) => [status, ...prev]);
    } catch { /* ignore */ }
  }, { enabled: !!hashtag, extraParams: hashtag ? { tag: hashtag.toLowerCase() } : undefined });

  async function fetchTimeline() {
    setLoading(true);
    setHasMore(true);
    seenIdsRef.current = new Set();
    const res = await fetch(`/api/v1/timelines/tag/${encodeURIComponent(hashtag)}?limit=20`);
    if (res.ok) {
      const data = await res.json() as Status[];
      setStatuses(data);
      for (const s of data) seenIdsRef.current.add(s.id);
      if (data.length < 20) setHasMore(false);
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

  async function fetchTagInfo() {
    if (!token) return;
    const res = await fetch(`/api/v1/tags/${encodeURIComponent(hashtag)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as { following?: boolean };
      setFollowing(data.following ?? false);
    }
  }

  async function handleToggleFollow() {
    if (!token || followBusy) return;
    setFollowBusy(true);
    try {
      const path = following ? "unfollow" : "follow";
      const res = await fetch(`/api/v1/tags/${encodeURIComponent(hashtag)}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setFollowing(!following);
    } catch {
      // silently fail
    } finally {
      setFollowBusy(false);
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore || statuses.length === 0) return;
    setLoadingMore(true);
    const lastId = statuses[statuses.length - 1].id;
    const res = await fetch(
      `/api/v1/timelines/tag/${encodeURIComponent(hashtag)}?max_id=${encodeURIComponent(lastId)}&limit=20`
    );
    if (res.ok) {
      const more = await res.json() as Status[];
      setStatuses((prev) => [...prev, ...more]);
      if (more.length < 20) setHasMore(false);
    }
    setLoadingMore(false);
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

  useEffect(() => {
    if (!hashtag) return;
    void fetchTimeline();
    void fetchMe();
    void fetchTagInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashtag]);

  // Infinite scroll
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
      <Sidebar me={me} currentPath={`/tags/${hashtag}`} />

      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Header */}
        <div
          style={{
            padding: "0.875rem 1rem",
            borderBottom: "1px solid var(--border)",
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              type="button"
              onClick={() => history.back()}
              className="btn btn-ghost btn-sm"
              style={{ padding: "0.3rem 0.5rem", fontSize: "1rem" }}
            >
              ←
            </button>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontWeight: 700, fontSize: "1.15rem", margin: 0 }}>
                #{hashtag}
              </h1>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: 0 }}>
                {t.hashtag_timeline} #{hashtag}
              </p>
            </div>
            {token && (
              <button
                type="button"
                className={`btn btn-sm ${following ? "btn-ghost" : "btn-primary"}`}
                style={{ flexShrink: 0, fontSize: "0.8rem" }}
                onClick={() => void handleToggleFollow()}
                disabled={followBusy}
              >
                {followBusy ? "…" : following ? t.followed_tags_unfollow : t.account_follow}
              </button>
            )}
          </div>
        </div>

        {/* Loading skeletons */}
        {loading && (
          <div>
            {[1, 2, 3].map((i) => (
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
            <span style={{ fontSize: "2.5rem", display: "block", marginBottom: "0.75rem" }}>#️⃣</span>
            <p style={{ fontWeight: 600 }}>{t.hashtag_empty}</p>
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
            <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              {loadingMore ? t.loading : hasMore ? "" : ""}
            </div>
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
