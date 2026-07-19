"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";

interface Announcement {
  id: string;
  content: string;
  published_at: string;
  updated_at: string;
  all_day: boolean;
  read: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function AnnouncementsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchAnnouncements();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchAnnouncements() {
    if (!token) return;
    setLoading(true);
    const res = await fetch("/api/v1/announcements", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setAnnouncements(await res.json() as Announcement[]);
    setLoading(false);
  }

  async function handleDismiss(id: string) {
    if (!token) return;
    setDismissing(id);
    const res = await fetch(`/api/v1/announcements/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    setDismissing(null);
  }

  function formatDate(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString();
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/announcements" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">Announcements</h1>
        </div>
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : announcements.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>📢</div>
            <div style={{ fontWeight: 600 }}>No announcements</div>
          </div>
        ) : (
          announcements.map((a) => (
            <div
              key={a.id}
              style={{
                padding: "1rem",
                borderBottom: "1px solid var(--border)",
                opacity: a.read ? 0.6 : 1,
              }}
            >
              <div
                style={{ fontSize: "0.95rem", color: "var(--text-primary)", marginBottom: "0.5rem", lineHeight: 1.6 }}
                dangerouslySetInnerHTML={{ __html: a.content }}
              />
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                <span>{formatDate(a.published_at)}</span>
                {!a.read && <span className="badge badge-accent" style={{ fontSize: "0.68rem" }}>New</span>}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ marginTop: "0.5rem", color: "var(--accent)" }}
                disabled={dismissing === a.id}
                onClick={() => void handleDismiss(a.id)}
              >
                {dismissing === a.id ? "…" : "Dismiss"}
              </button>
            </div>
          ))
        )}
      </main>
    </div>
  );
}
