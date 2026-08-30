"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { StatusCard } from "@/components/StatusCard";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { useLimits } from "@/lib/limits-client";
import type { Status, Me } from "@/components/StatusCard";
import { Icon } from "@/components/Icon";

export default function FavouritesPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const token = getToken();
  const { t } = useLocale();
  const limits = useLimits();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(async (maxId?: string) => {
    if (!token) return { items: [], hasMore: false };
    const base = `/api/v1/favourites?limit=${limits.defaultTimelinePage}`;
    const url = maxId ? `${base}&max_id=${encodeURIComponent(maxId)}` : base;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { items: [], hasMore: true };
    const items = await res.json() as Status[];
    return { items, hasMore: items.length >= limits.defaultTimelinePage };
  }, [token, limits.defaultTimelinePage]);

  const { statuses, loading, loadingMore, hasMore, loadMore } = useTimelineCache("favourites", fetchPage, { refetchOnMount: true });

  useEffect(() => {
    async function fetchMe() {
      if (!token) return;
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }

    if (!token) { router.push("/login"); return; }
    void fetchMe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <PageLayout sidebar={<Sidebar me={me} currentPath="/favourites" />}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">{t.favourites_title}</h1>
        </div>
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : statuses.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}><Icon name="heart" size="2rem" /></div>
            <div style={{ fontWeight: 600 }}>{t.favourites_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.favourites_empty_sub}</div>
          </div>
        ) : (
          <>
            {statuses.map((s) => (
              <div key={s.id} data-status-id={s.id}>
                <StatusCard
                  status={s}
                  me={me}
                  onFav={() => {}}
                  onReblog={() => {}}
                  onReply={() => router.push(`/statuses/${encodeURIComponent(s.id)}`)}
                  onQuote={(s) => router.push(`/statuses/${encodeURIComponent(s.id)}?quote=1`)}
                  onDelete={() => {}}
                  onEdit={() => {}}
                />
              </div>
            ))}
            <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
              {loadingMore ? t.loading : ""}
            </div>
          </>
        )}
    </PageLayout>
  );
}
