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
import { useNewStatusesBuffer } from "@/lib/streaming/use-new-statuses";
import NewStatusesPill from "@/components/NewStatusesPill";
import { StatusCard, Status, Me } from "@/components/StatusCard";
import { BackToTop } from "@/components/BackToTop";
import { Icon } from "@/components/Icon";
import { EditStatusModal } from "@/components/EditStatusModal";
import { useLimits } from "@/lib/limits-client";
import { Loading } from "@/components/Loading";
import { Tabs } from "@/components/Tabs";

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
    // Throw on failure: the cache hook keeps the current feed and retries later.
    if (!res.ok) throw new Error(`public timeline failed: ${res.status}`);
    const items = await res.json() as Status[];
    return { items, hasMore: items.length >= limit };
  }, [view, limits.defaultTimelinePage, limits.pageSize]);

  // Filled right after the buffer exists (the hook's background refetch
  // defers statuses into it when the reader is scrolled away).
  const bufferRef = useRef<{ queueItems: (items: Status[]) => void } | null>(null);
  const { statuses, setStatuses, loading, loadingMore, hasMore, seenIdsRef, loadMore, refresh, catchUp } = useTimelineCache(view, fetchPage, {
    resetScrollOnEntry: true,
    refetchOnMount: true,
    onDeferredItems: (items) => bufferRef.current?.queueItems(items),
  });
  const { pendingCount, reveal, queueItems, handleStreamEvent } = useNewStatusesBuffer(setStatuses, seenIdsRef);
  useEffect(() => {
    bufferRef.current = { queueItems };
  }, [queueItems]);

  // Streaming: subscribe to the correct channel whenever the view changes
  const streamName = view === "local" ? "public:local" : "public";
  useTimelineStream(streamName, (event, payload) => {
    handleStreamEvent(event, payload);
  }, { onReconnect: () => { void catchUp(); } });

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

  const handleFav = useCallback((updated: Status) => {
    setStatuses((prev) => prev.map((x) => x.id === updated.id ? { ...x, favourited: updated.favourited, favourites_count: updated.favourites_count } : x));
  }, [setStatuses]);

  const handleReblog = useCallback((updated: Status) => {
    setStatuses((prev) => prev.map((x) => x.id === updated.id ? { ...x, reblogged: updated.reblogged, reblogs_count: updated.reblogs_count } : x));
  }, [setStatuses]);

  const openEdit = useCallback((s: Status) => {
    setEditingStatus(s);
  }, []);

  const handleStatusSaved = useCallback((updated: Status) => {
    setStatuses((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
  }, [setStatuses]);

  const handleDelete = useCallback(async (s: Status) => {
    if (!token) return;
    if (!confirm(t.status_delete_confirm)) return;
    const res = await fetch(`/api/v1/statuses/${encodeURIComponent(s.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) => prev.filter((x) => x.id !== s.id));
      purgeStatusFromCache(s.id);
    }
  }, [token, t, setStatuses]);

  const handleReply = useCallback((s: Status) => {
    router.push(`/statuses/${encodeURIComponent(s.id)}?reply=1`);
  }, [router]);

  const handleQuote = useCallback((s: Status) => {
    router.push(`/statuses/${encodeURIComponent(s.id)}?quote=1`);
  }, [router]);

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
        {/* Sticky header with tabs: the title row draws the line above the tabs,
            the tab row the one the indicator sits on (like Notifications). */}
        <div
          style={{
            position: "sticky",
            top: 0,
            background: "var(--bg)",
            zIndex: 10,
          }}
        >
          <div style={{ padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)" }}>
            <h1 style={{ fontWeight: 700, fontSize: "1.2rem" }}>
              {t.nav_timelines}
            </h1>
          </div>
          <Tabs
            tabs={(token ? (["local", "federated"] as TimelineView[]) : (["federated"] as TimelineView[])).map((v) => ({
              key: v,
              label: v === "local" ? <><Icon name="home" /> {t.timeline_local}</> : <><Icon name="globe" /> {t.timeline_federated}</>,
            }))}
            active={view}
            onChange={switchView}
          />
          <NewStatusesPill count={pendingCount} onClick={reveal} anchor="header" />
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
                  onReply={handleReply}
                  onQuote={handleQuote}
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
