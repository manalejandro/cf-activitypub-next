"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { purgeStatusFromCache } from "@/lib/streaming/timeline-cache";
import { StatusCard, Status, Me } from "@/components/StatusCard";
import { Icon } from "@/components/Icon";
import { EditStatusModal } from "@/components/EditStatusModal";
import { useLimits } from "@/lib/limits-client";

interface TagInfo {
  id: string;
  name: string;
  url: string;
  following: boolean;
  history: { day: string; accounts: string; uses: string }[];
}

export default function TagPage() {
  const params = useParams();
  const tagName = typeof params.id === "string" ? decodeURIComponent(params.id) : "";

  const [me, setMe] = useState<Me | null>(null);
  const [tagInfo, setTagInfo] = useState<TagInfo | null>(null);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  const { t } = useLocale();
  const limits = useLimits();

  const token = getToken();
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPage = useCallback(async (maxId?: string) => {
    const base = `/api/v1/timelines/tag/${encodeURIComponent(tagName)}?limit=${limits.defaultTimelinePage}`;
    const url = maxId ? `${base}&max_id=${encodeURIComponent(maxId)}` : base;
    const res = await fetch(url);
    if (!res.ok) return { items: [], hasMore: true };
    const items = await res.json() as Status[];
    return { items, hasMore: items.length >= limits.defaultTimelinePage };
  }, [tagName, limits.defaultTimelinePage]);

  const { statuses, setStatuses, loading, loadingMore, hasMore, seenIdsRef, loadMore } = useTimelineCache(`tag:${tagName}`, fetchPage, { refetchOnMount: true });

  const totalAccounts = tagInfo?.history?.reduce((sum, h) => sum + parseInt(h.accounts || "0"), 0) ?? 0;

  async function pollTimeline() {
    if (loading || statuses.length === 0) return;
    const topId = statuses[0]?.id;
    // since_id returns only posts NEWER than the current newest one, so live
    // polling actually picks up newly published statuses (max_id is the reverse).
    let url = `/api/v1/timelines/tag/${encodeURIComponent(tagName)}?limit=${limits.defaultTimelinePage}`;
    if (topId) url += `&since_id=${encodeURIComponent(topId)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json() as Status[];
      const newStatuses = data.filter((s) => !seenIdsRef.current.has(s.id));
      for (const s of newStatuses) seenIdsRef.current.add(s.id);
      if (newStatuses.length > 0) {
        setStatuses((prev) => [...newStatuses, ...prev]);
      }
    }
  }

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchTagInfo() {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(`/api/v1/tags/${encodeURIComponent(tagName)}`, { headers });
    if (res.ok) {
      const data = await res.json() as TagInfo;
      setTagInfo(data);
      setFollowing(data.following ?? false);
    }
  }

  async function handleToggleFollow() {
    if (!token || followBusy) return;
    setFollowBusy(true);
    try {
      const path = following ? "unfollow" : "follow";
      const res = await fetch(`/api/v1/tags/${encodeURIComponent(tagName)}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setFollowing(!following);
        setTagInfo((prev) => prev ? { ...prev, following: !following } : null);
      }
    } catch {
      // silently fail
    } finally {
      setFollowBusy(false);
    }
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

  useEffect(() => {
    if (!tagName) return;
    Promise.resolve().then(() => void fetchMe());
    Promise.resolve().then(() => void fetchTagInfo());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagName, limits.defaultTimelinePage]);

  // Periodic polling every 30 seconds
  useEffect(() => {
    if (!tagName || loading) return;
    pollRef.current = setInterval(() => void pollTimeline(), 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagName, loading, statuses.length]);

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
    <>
    <PageLayout sidebar={<Sidebar me={me} currentPath={`/tags/${tagName}`} />}>
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
              onClick={() => router.back()}
              className="btn btn-ghost btn-sm"
              style={{ padding: "0.3rem 0.5rem", fontSize: "1rem" }}
            >
              <Icon name="arrow-left" />
            </button>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontWeight: 700, fontSize: "1.15rem", margin: 0 }}>
                #{tagName}
              </h1>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: "0.15rem 0 0" }}>
                {totalAccounts > 0
                  ? `${totalAccounts} ${totalAccounts === 1 ? "persona" : "personas"} hablando sobre este tag`
                  : t.hashtag_timeline}
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
            <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              {loadingMore ? t.loading : ""}
            </div>
          </div>
        )}
    </PageLayout>

      {/* Edit status modal */}
      <EditStatusModal status={editingStatus} onClose={() => setEditingStatus(null)} onSaved={handleStatusSaved} />
    </>
  );
}
