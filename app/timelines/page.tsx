"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { getLastTimelineView, setLastTimelineView, purgeStatusFromCache, clearAllTimelineCaches } from "@/lib/streaming/timeline-cache";
import { StatusCard, Status, Me } from "@/components/StatusCard";
import { BackToTop } from "@/components/BackToTop";
import { Icon } from "@/components/Icon";
import { EditStatusModal } from "@/components/EditStatusModal";
import { useLimits } from "@/lib/limits-client";
import { Loading } from "@/components/Loading";

type TimelineView = "local" | "federated";

export default function TimelinesPage() {
  const token = getToken();
  const [view, setView] = useState<TimelineView>(() => {
    // The local timeline requires auth, so anonymous visitors always land on
    // the federated view.
    if (!token) return "federated";
    const saved = getLastTimelineView();
    return saved === "local" || saved === "federated" ? saved : "local";
  });
  const [me, setMe] = useState<Me | null>(null);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const { t } = useLocale();
  const limits = useLimits();

  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(async (maxId?: string) => {
    const local = view === "local";
    const limit = maxId ? limits.defaultTimelinePage : limits.pageSize;
    const url = `/api/v1/timelines/public?limit=${limit}${local ? "&local=true" : ""}${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) return { items: [], hasMore: true };
    const items = await res.json() as Status[];
    return { items, hasMore: items.length >= limit };
  }, [view, limits.defaultTimelinePage, limits.pageSize]);

  const { statuses, setStatuses, loading, loadingMore, hasMore, seenIdsRef, loadMore, refresh } = useTimelineCache(view, fetchPage, { resetScrollOnEntry: true, refetchOnMount: true });

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
    setEditingStatus(s);
  }

  function handleStatusSaved(updated: Status) {
    setStatuses((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
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
      purgeStatusFromCache(s.id);
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

  // Filters changed (settings screen / server): refetch with the new rules.
  useEffect(() => {
    const handler = () => { clearAllTimelineCaches(); void refresh(); };
    window.addEventListener("cf-ap:filters-changed", handler);
    return () => window.removeEventListener("cf-ap:filters-changed", handler);
  }, [refresh]);

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
    <PageLayout sidebar={<Sidebar me={me} currentPath="/timelines" />}>
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
            {(token ? (["local", "federated"] as TimelineView[]) : (["federated"] as TimelineView[])).map((v) => (
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
                  filterContext="public"
                  status={s}
                  onFav={handleFav}
                  onReblog={handleReblog}
                  onReply={(status) => router.push(`/statuses/${encodeURIComponent(status.id)}?reply=1`)}
                  onQuote={(status) => router.push(`/statuses/${encodeURIComponent(status.id)}?quote=1`)}
                  me={me ?? undefined}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                />
              </div>
            ))}
            <div ref={bottomRef} style={{ height: 1 }} />
            {loadingMore && <Loading compact />}
          </div>
        )}
      </PageLayout>

      {/* Edit status modal */}
      <EditStatusModal status={editingStatus} onClose={() => setEditingStatus(null)} onSaved={handleStatusSaved} />
      <BackToTop />
    </>
  );
}
