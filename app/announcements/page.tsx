"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { RichText } from "@/components/RichText";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";
import { useLimits } from "@/lib/limits-client";

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
  roles?: { name: string }[];
}

export default function AnnouncementsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const token = getToken();
  const { t } = useLocale();
  const limits = useLimits();

  const isMod = me?.roles?.[0]?.name?.toLowerCase() === "admin" || me?.roles?.[0]?.name?.toLowerCase() === "moderator";

  useEffect(() => {
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

    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchAnnouncements();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !draft.trim() || creating) return;
    setCreating(true);
    const res = await fetch("/api/v1/announcements", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: draft.trim() }),
    });
    if (res.ok) {
      const created = await res.json() as Announcement;
      setAnnouncements((prev) => [created, ...prev]);
      setDraft("");
    }
    setCreating(false);
  }

  async function handleDelete(id: string) {
    if (!token) return;
    if (!confirm(t.announcements_delete_confirm)) return;
    setDeleting(id);
    const res = await fetch(`/api/v1/announcements/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setAnnouncements((prev) => prev.filter((a) => a.id !== id));
    setDeleting(null);
  }

  function formatDate(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString();
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/announcements" />}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">{t.announcements_title}</h1>
        </div>
        {isMod && (
          <form
            onSubmit={handleCreate}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "1rem", borderBottom: "1px solid var(--border)" }}
          >
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t.announcements_create_placeholder}
              aria-label={t.announcements_create_placeholder}
              rows={2}
              maxLength={limits.maxAnnouncementChars}
              className="input"
              style={{ resize: "vertical" }}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={creating || !draft.trim()}
              style={{ alignSelf: "flex-start" }}
            >
              {creating ? "…" : t.announcements_create_submit}
            </button>
          </form>
        )}
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : announcements.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}><Icon name="bullhorn" size="2rem" /></div>
            <div style={{ fontWeight: 600 }}>{t.announcements_empty}</div>
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
              >
                <RichText html={a.content} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.82rem", color: "var(--text-muted)" }}>
                <span>{formatDate(a.published_at)}</span>
                {!a.read && <span className="badge badge-accent" style={{ fontSize: "0.68rem" }}>{t.announcements_new}</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ color: "var(--accent)" }}
                  disabled={dismissing === a.id}
                  onClick={() => void handleDismiss(a.id)}
                >
                  {dismissing === a.id ? "…" : t.announcements_dismiss}
                </button>
                {isMod && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--danger)" }}
                    disabled={deleting === a.id}
                    onClick={() => void handleDelete(a.id)}
                  >
                    {deleting === a.id ? "…" : t.announcements_delete}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
    </PageLayout>
  );
}