"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { RichText } from "@/components/RichText";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/Avatar";

interface Report {
  id: string;
  action_taken: boolean;
  action_taken_at: string | null;
  category: string;
  comment: string;
  forwarded: boolean;
  created_at: string;
  status_ids: string[];
  statuses: {
    id: string;
    content: string;
    created_at: string | null;
    account: {
      id: string;
      username: string;
      acct: string;
      display_name: string;
      avatar: string;
    } | null;
  }[];
  rule_ids: string[];
  target_account: {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
  } | null;
  reporter_account: {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
  } | null;
  notes: {
    id: string;
    content: string;
    created_at: string;
  }[];
}

export default function AdminReportsPage() {
  const router = useRouter();
  const { t } = useLocale();
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
    Promise.resolve().then(() => void fetchReports());
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
      await fetch(`/api/v1/admin/accounts/${encodeURIComponent(targetId)}/suspend`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      await performAction(reportId, "resolve");
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  async function deleteReport(id: string) {
    if (!token) return;
    setActionLoading(`${id}:delete`);
    try {
      await fetch(`/api/v1/admin/reports/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchReports();
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  async function addNote(reportId: string, content: string) {
    if (!token || !content.trim()) return false;
    setActionLoading(`${reportId}:note`);
    try {
      const res = await fetch(`/api/v1/admin/reports/${encodeURIComponent(reportId)}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) return false;
      await fetchReports();
      return true;
    } catch { return false; }
    finally { setActionLoading(null); }
  }

  const openReports = reports.filter((r) => !r.action_taken);
  const resolvedReports = reports.filter((r) => r.action_taken);

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>
        <Icon name="flag" /> {t.admin_reports_title}
        {openReports.length > 0 && (
          <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
            ({openReports.length} {t.admin_reports_open.toLowerCase()})
          </span>
        )}
      </h1>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_loading_reports}</div>
      ) : reports.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_no_reports}</div>
      ) : (
        <>
          <Section title={t.admin_reports_open} count={openReports.length}>
            {openReports.length === 0 ? (
              <div style={{ color: "var(--text-muted)", padding: "1rem 0" }}>{t.admin_reports_all_clear}</div>
            ) : (
              openReports.map((r) => (
                <ReportCard
                  key={r.id}
                  report={r}
                  t={t}
                  actionLoading={actionLoading}
                  onResolve={() => performAction(r.id, "resolve")}
                  onDismiss={() => performAction(r.id, "dismiss")}
                  onSuspendAccount={() => r.target_account ? suspendReportedAccount(r.target_account.id, r.id) : null}
                  onAddNote={(content) => addNote(r.id, content)}
                />
              ))
            )}
          </Section>

          {resolvedReports.length > 0 && (
            <Section title={t.admin_reports_resolved} count={resolvedReports.length}>
              {resolvedReports.map((r) => (
                <ReportCard
                  key={r.id}
                  report={r}
                  t={t}
                  actionLoading={actionLoading}
                  resolved
                  onReopen={() => performAction(r.id, "reopen")}
                  onDelete={() => deleteReport(r.id)}
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
  t,
  actionLoading,
  resolved,
  onResolve,
  onDismiss,
  onSuspendAccount,
  onReopen,
  onDelete,
  onAddNote,
}: {
  report: Report;
  t: Translations;
  actionLoading: string | null;
  resolved?: boolean;
  onResolve?: () => void;
  onDismiss?: () => void;
  onSuspendAccount?: (() => void) | null;
  onReopen?: () => void;
  onDelete?: () => void;
  onAddNote?: (content: string) => Promise<boolean>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [sending, setSending] = useState(false);

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
          <Avatar
            avatar={report.target_account?.avatar}
            name={report.target_account?.display_name || report.target_account?.username || "?"}
            size={34}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "0.9rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {t.admin_reported_account}: {report.target_account?.display_name || report.target_account?.username || t.admin_reported_unknown}
            </div>
            <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
              {report.category} · {formatDate(report.created_at)}
            </div>
            {report.reporter_account && (
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                {t.admin_reported_by.replace("{user}", report.reporter_account.display_name || report.reporter_account.username)}
              </div>
            )}
          </div>
        </div>

        {!resolved && (
          <div style={{ display: "flex", gap: "0.375rem", flexShrink: 0 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={actionLoading === `${report.id}:resolve` || actionLoading === `${report.id}:suspend`}
              onClick={onResolve}
            >
              {actionLoading === `${report.id}:resolve` ? "..." : t.admin_btn_resolve}
            </button>
            <button
              className="btn btn-outline btn-sm"
              disabled={actionLoading === `${report.id}:dismiss`}
              onClick={onDismiss}
            >
              {actionLoading === `${report.id}:dismiss` ? "..." : t.admin_btn_dismiss}
            </button>
            {report.target_account && onSuspendAccount && (
              <button
                className="btn btn-outline btn-sm"
                style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                disabled={actionLoading === `${report.id}:suspend`}
                onClick={onSuspendAccount}
              >
                {actionLoading === `${report.id}:suspend` ? "..." : t.admin_btn_suspend}
              </button>
            )}
          </div>
        )}

        {resolved && (
          <div style={{ display: "flex", gap: "0.375rem", flexShrink: 0, alignItems: "center" }}>
            <span className="badge badge-success">{t.admin_status_resolved}</span>
            <button
              className="btn btn-outline btn-sm"
              disabled={actionLoading === `${report.id}:reopen`}
              onClick={onReopen}
            >
              {actionLoading === `${report.id}:reopen` ? "..." : t.admin_btn_reopen}
            </button>
            <button
              className="btn btn-outline btn-sm"
              style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
              disabled={actionLoading === `${report.id}:delete`}
              onClick={onDelete}
            >
              {actionLoading === `${report.id}:delete` ? "..." : t.admin_btn_delete}
            </button>
          </div>
        )}
      </div>

      {report.comment && (
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", padding: "0.5rem 0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)" }}>
          {report.comment}
        </div>
      )}

      {report.statuses.length > 0 && (
        <div>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "0.8rem", color: "var(--text-secondary)", padding: "0.25rem 0" }}
            onClick={() => setExpanded((v) => !v)}
          >
            {(expanded ? t.admin_hide_posts : t.admin_show_posts).replace("{count}", String(report.statuses.length))}
          </button>

          {expanded && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
              {report.statuses.map((s) => (
                <div key={s.id} style={{ fontSize: "0.85rem", padding: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginBottom: "0.375rem" }}>
                    <span style={{ fontWeight: 600 }}>
                      {s.account?.display_name || s.account?.username || t.admin_reported_unknown}
                    </span>
                    {s.created_at && (
                      <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                        {formatDate(s.created_at)}
                      </span>
                    )}
                  </div>
                  <RichText html={s.content} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(report.notes.length > 0 || onAddNote) && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {t.admin_discussion} ({report.notes.length})
          </div>

          {report.notes.map((n) => (
            <div key={n.id} style={{ fontSize: "0.85rem", padding: "0.625rem 0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginBottom: "0.25rem" }}>
                <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>{t.admin_reports_title}</span>
                <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>{formatDate(n.created_at)}</span>
              </div>
              <div style={{ color: "var(--text)", whiteSpace: "pre-wrap" }}>{n.content}</div>
            </div>
          ))}

          {onAddNote && (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder={t.admin_note_placeholder}
                aria-label={t.admin_note_placeholder}
                rows={2}
                style={{
                  flex: 1, padding: "0.5rem 0.75rem", borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border)", background: "var(--bg)",
                  color: "var(--text)", fontSize: "0.85rem", fontFamily: "inherit",
                  resize: "vertical",
                }}
              />
              <button
                className="btn btn-outline btn-sm"
                disabled={sending || !noteText.trim() || actionLoading === `${report.id}:note`}
                onClick={async () => {
                  if (!onAddNote) return;
                  setSending(true);
                  const ok = await onAddNote(noteText);
                  if (ok) setNoteText("");
                  setSending(false);
                }}
              >
                {actionLoading === `${report.id}:note` ? "..." : t.admin_btn_add_note}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
