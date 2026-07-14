"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { StatusCard } from "@/components/StatusCard";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import type { Status, Me } from "@/components/StatusCard";

export default function BookmarksPage() {
  const router = useRouter();
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchBookmarks();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchBookmarks() {
    if (!token) return;
    const res = await fetch("/api/v1/bookmarks", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setStatuses(await res.json() as Status[]);
    setLoading(false);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/bookmarks" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">{t.bookmarks_title}</h1>
        </div>
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : statuses.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🔖</div>
            <div style={{ fontWeight: 600 }}>{t.bookmarks_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.bookmarks_empty_sub}</div>
          </div>
        ) : (
          statuses.map((s) => (
            <StatusCard
              key={s.id}
              status={s}
              me={me}
              onFav={() => {}}
              onReblog={() => {}}
              onReply={() => router.push(`/statuses/${encodeURIComponent(s.id)}`)}
              onDelete={() => {}}
              onEdit={() => {}}
            />
          ))
        )}
      </main>
    </div>
  );
}
