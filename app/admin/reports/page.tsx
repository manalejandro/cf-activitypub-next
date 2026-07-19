"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";

interface Report {
  id: string;
  action_taken: boolean;
  action_taken_at: string | null;
  category: string;
  comment: string;
  forwarded: boolean;
  created_at: string;
  status_ids: string[];
  rule_ids: string[];
  target_account: {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
  } | null;
}

export default function AdminReportsPage() {
  const router = useRouter();
  const token = getToken();

  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/reports", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      const data = await res.json() as Report[];
      setReports(data);
    } catch {
      router.push("/login");
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  async function performAction(id: string, action: string) {
    if (!token) return;
    setActionLoading(`${id}:${action}`);
    try {
      await fetch(`/api/v1/admin/reports/${id}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchReports();
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  async function suspendReportedAccount(targetId: string, reportId: string) {
    if (!token) return;
    setActionLoading(`${reportId}:suspend`);
    try {
      await fetch(`/api/v1/admin/accounts/${targetId}/suspend`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      await performAction(reportId, "resolve");
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  const openReports = reports.filter((r) => !r.action_taken);
  const resolvedReports = reports.filter((r) => r.action_taken);

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>
        Reports
        {openReports.length > 0 && (
          <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
            ({openReports.length} open)
          </span>
        )}
      </h1>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>Loading reports...</div>
      ) : reports.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>No reports yet.</div>
      ) : (
        <>
          <Section title="Open" count={openReports.length}>
            {openReports.length === 0 ? (
              <div style={{ color: "var(--text-muted)", padding: "1rem 0" }}>All clear — no open reports.</div>
            ) : (
              openReports.map((r) => (
                <ReportCard
                  key={r.id}
                  report={r}
                  actionLoading={actionLoading}
                  onResolve={() => performAction(r.id, "resolve")}
                  onDismiss={() => performAction(r.id, "dismiss")}
                  onSuspendAccount={() => r.target_account ? suspendReportedAccount(r.target_account.id, r.id) : null}
                />
              ))
            )}
          </Section>

          {resolvedReports.length > 0 && (
            <Section title="Resolved" count={resolvedReports.length}>
              {resolvedReports.map((r) => (
                <ReportCard
                  key={r.id}
                  report={r}
                  actionLoading={actionLoading}
                  resolved
                />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "2rem" }}>
      <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem", color: "var(--text-secondary)" }}>
        {title}
        <span style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginLeft: "0.375rem" }}>({count})</span>
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {children}
      </div>
    </div>
  );
}

function ReportCard({
  report,
  actionLoading,
  resolved,
  onResolve,
  onDismiss,
  onSuspendAccount,
}: {
  report: Report;
  actionLoading: string | null;
  resolved?: boolean;
  onResolve?: () => void;
  onDismiss?: () => void;
  onSuspendAccount?: (() => void) | null;
}) {
  return (
    <div
      className="card"
      style={{
        padding: "1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.625rem",
        opacity: resolved ? 0.7 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.625rem", minWidth: 0, flex: 1 }}>
          <div
            className="avatar"
            style={{ width: 34, height: 34, background: "var(--bg-overlay)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)", flexShrink: 0 }}
          >
            {report.target_account
              ? (report.target_account.display_name?.[0] ?? report.target_account.username[0]).toUpperCase()
              : "?"}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Reported: {report.target_account?.display_name || report.target_account?.username || "Unknown"}
            </div>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              {report.category} · {formatDate(report.created_at)}
            </div>
          </div>
        </div>

        {!resolved && (
          <div style={{ display: "flex", gap: "0.375rem", flexShrink: 0 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={actionLoading === `${report.id}:resolve` || actionLoading === `${report.id}:suspend`}
              onClick={onResolve}
            >
              {actionLoading === `${report.id}:resolve` ? "..." : "Resolve"}
            </button>
            <button
              className="btn btn-outline btn-sm"
              disabled={actionLoading === `${report.id}:dismiss`}
              onClick={onDismiss}
            >
              {actionLoading === `${report.id}:dismiss` ? "..." : "Dismiss"}
            </button>
            {report.target_account && onSuspendAccount && (
              <button
                className="btn btn-outline btn-sm"
                style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                disabled={actionLoading === `${report.id}:suspend`}
                onClick={onSuspendAccount}
              >
                {actionLoading === `${report.id}:suspend` ? "..." : "Suspend"}
              </button>
            )}
          </div>
        )}

        {resolved && (
          <span className="badge badge-success" style={{ flexShrink: 0 }}>Resolved</span>
        )}
      </div>

      {report.comment && (
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", padding: "0.5rem 0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)" }}>
          {report.comment}
        </div>
      )}

      {report.status_ids && report.status_ids.length > 0 && (
        <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
          {report.status_ids.length} post{report.status_ids.length !== 1 ? "s" : ""} attached
        </div>
      )}
    </div>
  );
}
