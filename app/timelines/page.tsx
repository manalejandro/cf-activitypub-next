"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { getLastTimelineView, setLastTimelineView, purgeStatusFromCache } from "@/lib/streaming/timeline-cache";
import { statusHtmlToPlain } from "@/lib/activitypub/content";
import { StatusCard, Status, Me } from "@/components/StatusCard";
import { BackToTop } from "@/components/BackToTop";
import { Icon } from "@/components/Icon";

type TimelineView = "local" | "federated";

export default function TimelinesPage() {
  const [view, setView] = useState<TimelineView>(() => {
    const saved = getLastTimelineView();
    return saved === "local" || saved === "federated" ? saved : "local";
  });
  const [me, setMe] = useState<Me | null>(null);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const [editText, setEditText] = useState("");
  const [editSpoiler, setEditSpoiler] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const { t } = useLocale();

  const token = getToken();
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(async (maxId?: string) => {
    const local = view === "local";
    const limit = maxId ? 20 : 40;
    const url = `/api/v1/timelines/public?limit=${limit}${local ? "&local=true" : ""}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) return { items: [], hasMore: true };
    const items = await res.json() as Status[];
    return { items, hasMore: items.length > 0 };
  }, [view]);

  const { statuses, setStatuses, loading, loadingMore, hasMore, seenIdsRef, loadMore } = useTimelineCache(view, fetchPage, { resetScrollOnEntry: true });

  // Streaming: subscribe to the correct channel whenever the view changes
  const streamName = view === "local" ? "public:local" : "public";
  useTimelineStream(streamName, (event, payload) => {
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
      purgeStatusFromCache(deletedId);
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
    setEditText(statusHtmlToPlain(s.content));
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

  // Mount: initial account load (timeline is loaded by useTimelineCache)
  useEffect(() => {
    Promise.resolve().then(() => void fetchMe());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the active tab so back-navigation restores local vs. public
  useEffect(() => {
    setLastTimelineView(view);
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
    <>
    <PageLayout sidebar={<Sidebar me={me} currentPath="/timelines" />} rightPanel={!token ? (
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
      ) : undefined}>
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
                {v === "local" ? <><Icon name="home" /> {t.timeline_local}</> : <><Icon name="globe" /> {t.timeline_federated}</>}
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
              {view === "local" ? <Icon name="home" size="2.5rem" /> : <Icon name="globe" size="2.5rem" />}
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
              <div key={s.id} data-status-id={s.id}>
                <StatusCard
                  status={s}
                  onFav={handleFav}
                  onReblog={handleReblog}
                  onReply={(status) => router.push(`/statuses/${encodeURIComponent(status.id)}?reply=1`)}
                  me={me ?? undefined}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                />
              </div>
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
      </PageLayout>

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
                className="input"
                style={{ width: "100%" }}
              />
            ) : null}
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              placeholder={t.edit_status_placeholder}
              maxLength={500}
              className="input"
              style={{ resize: "none", minHeight: 120, fontFamily: "inherit", width: "100%" }}
            />
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
      <BackToTop />
    </>
  );
}
