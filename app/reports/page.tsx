"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { AvatarBubble, formatTime } from "@/components/StatusCard";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";

interface TargetAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface StatusPreview {
  id: string;
  content: string;
  account: TargetAccount;
  created_at: string;
}

interface Report {
  id: string;
  action_taken: boolean;
  action_taken_at: string | null;
  category: string;
  comment: string;
  forwarded: boolean;
  created_at: string;
  status_ids: string[];
  statuses: StatusPreview[];
  target_account: TargetAccount | null;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

function stripHtml(html: string): string {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? div.innerText ?? "";
}

const CATEGORY_LABELS: Record<string, string> = {
  spam: "Spam",
  violation: "Violation",
  other: "Other",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

export default function ReportsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchReports();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchReports() {
    if (!token) return;
    const res = await fetch("/api/v1/reports", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setReports(await res.json() as Report[]);
    setLoading(false);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/reports" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div
          style={{
            position: "sticky", top: 0, background: "var(--bg)",
            borderBottom: "1px solid var(--border)", padding: "0.75rem 1rem",
            display: "flex", alignItems: "center", gap: "1rem", zIndex: 10,
          }}
        >
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => router.back()}
            style={{ fontSize: "1.1rem" }}
          >
            ←
          </button>
          <span style={{ fontWeight: 600 }}>Reports</span>
        </div>

        {loading ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            {t.loading}
          </div>
        ) : reports.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🚩</div>
            <div style={{ fontWeight: 600 }}>You haven't submitted any reports</div>
          </div>
        ) : (
          reports.map((report) => {
            const status = report.statuses?.[0];
            const isRemote = report.target_account?.acct.includes("@");
            const profileHref = isRemote
              ? `/users/remote?url=${encodeURIComponent(report.target_account?.id ?? "")}`
              : `/users/${report.target_account?.username}`;
            return (
              <div
                key={report.id}
                style={{
                  display: "flex", gap: "0.875rem", padding: "1rem",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                {report.target_account && (
                  <Link href={profileHref} style={{ flexShrink: 0 }}>
                    <AvatarBubble account={report.target_account} size={42} />
                  </Link>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.3rem" }}>
                    {report.target_account && (
                      <Link href={profileHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
                        {report.target_account.display_name || report.target_account.username}
                      </Link>
                    )}
                    {report.target_account && (
                      <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                        @{report.target_account.acct}
                      </span>
                    )}
                    <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "auto" }}>
                      {formatTime(report.created_at)}
                    </span>
                  </div>

                  {status && (
                    <div
                      style={{
                        padding: "0.5rem 0.625rem", background: "var(--bg-elevated)",
                        borderRadius: "var(--radius-sm)", fontSize: "0.85rem",
                        color: "var(--text-secondary)", marginBottom: "0.4rem",
                        overflow: "hidden", textOverflow: "ellipsis",
                        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                      }}
                    >
                      {stripHtml(status.content)}
                    </div>
                  )}

                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", fontSize: "0.82rem" }}>
                    <span
                      style={{
                        display: "inline-block", padding: "0.15rem 0.5rem",
                        borderRadius: "99px", fontSize: "0.7rem", fontWeight: 600,
                        background: report.category === "spam" ? "color-mix(in srgb, var(--danger) 15%, transparent)" : "var(--accent-bg)",
                        color: report.category === "spam" ? "var(--danger)" : "var(--accent)",
                      }}
                    >
                      {CATEGORY_LABELS[report.category] ?? report.category}
                    </span>
                    <span
                      style={{
                        display: "inline-block", padding: "0.15rem 0.5rem",
                        borderRadius: "99px", fontSize: "0.7rem", fontWeight: 600,
                        background: report.action_taken ? "color-mix(in srgb, var(--accent) 15%, transparent)" : "color-mix(in srgb, var(--text-muted) 15%, transparent)",
                        color: report.action_taken ? "var(--accent)" : "var(--text-muted)",
                      }}
                    >
                      {report.action_taken ? "Resolved" : "Open"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
