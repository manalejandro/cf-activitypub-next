"use client";

import { useEffect, useState } from "react";
import { RichText } from "@/components/RichText";
import { Icon } from "@/components/Icon";
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

// Renders the instance's unread announcements at the top of the home feed,
// mirroring Mastodon's announcement bar: each has its text, a "New" badge and
// a dismiss button. Read announcements stay visible on /announcements.
export function AnnouncementsBanner() {
  const { t } = useLocale();
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const token = getToken();

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/v1/announcements", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data)) setAnnouncements(data as Announcement[]);
      })
      .catch(() => {
        /* banner is optional */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleDismiss(id: string) {
    if (!token) return;
    setDismissing(id);
    const res = await fetch(`/api/v1/announcements/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setAnnouncements((prev) => (prev ?? []).filter((a) => a.id !== id));
    setDismissing(null);
  }

  const unread = (announcements ?? []).filter((a) => !a.read);
  if (!announcements || unread.length === 0) return null;

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.625rem 1rem",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.82rem",
          fontWeight: 600,
          color: "var(--accent)",
        }}
      >
        <Icon name="bullhorn" />
        {t.announcements_title}
      </div>
      {unread.map((a) => (
        <div key={a.id} style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: "0.9rem", color: "var(--text-primary)", lineHeight: 1.6 }}>
            <RichText html={a.content} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem" }}>
            <span className="badge badge-accent" style={{ fontSize: "0.68rem" }}>{t.announcements_new}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ color: "var(--accent)" }}
              disabled={dismissing === a.id}
              onClick={() => void handleDismiss(a.id)}
            >
              {dismissing === a.id ? "…" : t.announcements_dismiss}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}