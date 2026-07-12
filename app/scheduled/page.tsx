"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";

interface ScheduledStatus {
  id: string;
  scheduled_at: string;
  params: {
    status?: string;
    text?: string;
    visibility?: string;
    sensitive?: boolean;
    spoiler_text?: string;
  };
  media_attachments: unknown[];
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function ScheduledPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [items, setItems] = useState<ScheduledStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchScheduled();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchScheduled() {
    if (!token) return;
    const res = await fetch("/api/v1/scheduled_statuses", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setItems(await res.json() as ScheduledStatus[]);
    setLoading(false);
  }

  async function handleCancel(id: string) {
    if (!token) return;
    setCancelling(id);
    const res = await fetch(`/api/v1/scheduled_statuses/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setItems((prev) => prev.filter((s) => s.id !== id));
    setCancelling(null);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/scheduled" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">{t.scheduled_title}</h1>
        </div>
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : items.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>📅</div>
            <div style={{ fontWeight: 600 }}>{t.scheduled_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.scheduled_empty_sub}</div>
          </div>
        ) : (
          items.map((s) => (
            <div key={s.id} style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginBottom: "0.25rem" }}>
                    📅 {new Date(s.scheduled_at + (s.scheduled_at.includes("T") || s.scheduled_at.includes("Z") ? "" : "Z")).toLocaleString()}
                  </div>
                  <div style={{ fontSize: "0.9rem", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.params.status || s.params.text || "(sin contenido)"}
                  </div>
                  {s.params.spoiler_text && (
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.2rem" }}>
                      ⚠️ {s.params.spoiler_text}
                    </div>
                  )}
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.2rem", display: "flex", gap: "0.5rem" }}>
                    <span>{s.params.visibility || "public"}</span>
                    {s.params.sensitive && <span>🔞</span>}
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ color: "var(--danger)", flexShrink: 0 }}
                  onClick={() => void handleCancel(s.id)}
                  disabled={cancelling === s.id}
                >
                  {cancelling === s.id ? "…" : t.scheduled_cancel}
                </button>
              </div>
            </div>
          ))
        )}
      </main>
    </div>
  );
}
