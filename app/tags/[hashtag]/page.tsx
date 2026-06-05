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

  useEffect(() => {
    if (!hashtag) return;
    void fetchTimeline();
    void fetchMe();
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
            <div>
              <h1 style={{ fontWeight: 700, fontSize: "1.15rem", margin: 0 }}>
                #{hashtag}
              </h1>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: 0 }}>
                {t.hashtag_timeline} #{hashtag}
              </p>
            </div>
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
              />
            ))}
            <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              {loadingMore ? t.loading : hasMore ? "" : ""}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
