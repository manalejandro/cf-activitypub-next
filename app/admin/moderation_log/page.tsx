"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";

interface LogEntry {
  id: string;
  createdAt: string;
  source: string;
  targetType: string;
  targetId: string | null;
  action: string;
  reason: string | null;
  confidence: "low" | "medium" | "high" | null;
  model: string;
  details: Record<string, unknown>;
  emailSent: boolean;
  emailTo: string | null;
  relatedId: string | null;
}

interface LogResponse {
  log: LogEntry[];
}

const SOURCE_MAP: Record<string, string> = {
  ai: "admin_source_guardian",
  heuristic: "admin_source_guardian",
  system: "admin_source_system",
  user: "admin_source_user",
  admin: "admin_source_admin",
};

const ACTION_MAP: Record<string, string> = {
  deleted: "admin_action_deleted",
  suspended: "admin_action_suspended",
  unsuspended: "admin_action_unsuspended",
  silenced: "admin_action_silenced",
  unsilenced: "admin_action_unsilenced",
  approved: "admin_action_approved",
  rejected: "admin_action_rejected",
  promoted: "admin_action_promoted",
  demoted: "admin_action_demoted",
  blocked: "admin_action_blocked",
  reported: "admin_action_reported",
  resolved: "admin_action_resolved",
  reopened: "admin_action_reopened",
  warned: "admin_action_warned",
};

export default function AdminModerationLogPage() {
  const router = useRouter();
  const { t } = useLocale();
  const token = getToken();

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);

  const fetchLog = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/moderation_log?limit=100", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      const data = await res.json() as LogResponse;
      setEntries(data.log);
    } catch {
      router.push("/login");
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchLog());
  }, [fetchLog]);

  async function removeEntry(id: string) {
    if (!token || !window.confirm(t.admin_log_remove_confirm)) return;
    setActionLoading(id);
    try {
      const res = await fetch(`/api/v1/admin/moderation_log/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      await fetchLog();
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  async function clearAll() {
    if (!token || !window.confirm(t.admin_log_clear_all_confirm)) return;
    setClearingAll(true);
    try {
      const res = await fetch("/api/v1/admin/moderation_log", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      setEntries([]);
    } catch { /* ignore */ }
    setClearingAll(false);
  }

  function formatDate(dateStr: string) {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function label(key: string, fallback: string): string {
    const value = (t as Translations)[key as keyof Translations];
    return typeof value === "string" && value !== key ? value : fallback;
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>
        <Icon name="file-text-o" /> {t.admin_log_title}
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        {t.admin_log_desc}
      </p>

      {entries.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <button
            className="btn btn-outline btn-sm"
            style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
            disabled={clearingAll}
            onClick={() => void clearAll()}
          >
            {clearingAll ? "..." : t.admin_btn_clear_all}
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_loading_log}</div>
      ) : entries.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_no_log}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_time}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_source}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_target}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_action}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_confidence}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_reason}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_actions}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const sourceKey = SOURCE_MAP[e.source];
                const actionKey = ACTION_MAP[e.action];
                return (
                  <tr key={e.id} style={{ borderBottom: "1px solid var(--border)", verticalAlign: "top", transition: "background 0.1s" }}
                    onMouseOver={(ev) => (ev.currentTarget as HTMLElement).style.background = "var(--accent-bg)"}
                    onMouseOut={(ev) => (ev.currentTarget as HTMLElement).style.background = ""}
                  >
                    <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                      {formatDate(e.createdAt)}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      {sourceKey ? label(sourceKey, e.source) : e.source}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)" }}>
                      <div style={{ fontSize: "0.8rem" }}>{e.targetType}</div>
                      {e.targetId && (
                        <div style={{ fontSize: "0.72rem", fontFamily: "monospace", wordBreak: "break-all", maxWidth: 220 }}>{e.targetId}</div>
                      )}
                      {e.relatedId && e.relatedId !== e.targetId && (
                        <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.2rem" }}>
                          <span style={{ fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t.admin_col_account}: </span>
                          <span style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{e.relatedId}</span>
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      <span className="badge" style={{ background: "rgba(99,102,241,0.12)", color: "var(--accent)" }}>
                        {actionKey ? label(actionKey, e.action) : e.action}
                      </span>
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      {e.confidence ? (
                        <span className="badge" style={{
                          background: e.confidence === "high" ? "rgba(248,113,113,0.12)" : e.confidence === "medium" ? "rgba(251,191,36,0.12)" : "rgba(99,102,241,0.12)",
                          color: e.confidence === "high" ? "var(--danger)" : e.confidence === "medium" ? "var(--warning)" : "var(--accent)",
                        }}>
                          {e.confidence}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", maxWidth: 320 }}>
                      {e.reason || <span style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", textAlign: "right" }}>
                      <button
                        className="btn btn-outline btn-sm"
                        style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                        disabled={actionLoading === e.id}
                        onClick={() => removeEntry(e.id)}
                      >
                        {actionLoading === e.id ? "..." : t.admin_btn_remove}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}