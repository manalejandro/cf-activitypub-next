"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";

interface DomainBlock {
  domain: string;
  severity: string;
  reject_media: boolean;
  reject_reports: boolean;
  private_comment: string | null;
  public_comment: string | null;
  obfuscate: boolean;
  created_at: string;
}

export default function AdminBlockedPage() {
  const router = useRouter();
  const { t } = useLocale();
  const token = getToken();

  const [blocks, setBlocks] = useState<DomainBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newSeverity, setNewSeverity] = useState<"silence" | "suspend">("suspend");
  const [newReason, setNewReason] = useState("");
  const [busy, setBusy] = useState(false);

  const fetchBlocks = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/domain_blocks", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      const data = await res.json() as DomainBlock[];
      setBlocks(data);
    } catch {
      router.push("/login");
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchBlocks());
  }, [fetchBlocks]);

  async function unblock(domain: string) {
    if (!token) return;
    setActionLoading(domain);
    try {
      await fetch(`/api/v1/admin/domain_blocks?domain=${encodeURIComponent(domain)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchBlocks();
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const domain = newDomain.trim().toLowerCase();
    if (!token || !domain || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/v1/admin/domain_blocks", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain, severity: newSeverity, private_comment: newReason.trim() || null }),
      });
      if (res.ok) {
        setNewDomain("");
        setNewReason("");
        setAdding(false);
        await fetchBlocks();
      }
    } catch { /* ignore */ }
    setBusy(false);
  }

  function formatDate(dateStr: string) {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>
        <Icon name="lock" /> {t.admin_blocked_title}
        <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
          ({blocks.length})
        </span>
      </h1>

      <div style={{ marginBottom: "1rem" }}>
        {!adding ? (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            {t.admin_block_domain}
          </button>
        ) : (
          <form onSubmit={(e) => void handleAdd(e)} style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 480 }}>
            <input
              className="input"
              placeholder={t.admin_domain_ph}
              aria-label={t.admin_domain_ph}
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              autoFocus
            />
            <select
              className="input"
              aria-label={t.admin_col_severity}
              value={newSeverity}
              onChange={(e) => setNewSeverity(e.target.value as "silence" | "suspend")}
            >
              <option value="suspend">{t.admin_severity_suspended}</option>
              <option value="silence">{t.admin_severity_silenced}</option>
            </select>
            <input
              className="input"
              placeholder={t.admin_reason_ph}
              aria-label={t.admin_reason_ph}
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
            />
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!newDomain.trim() || busy}>
                {busy ? "…" : t.admin_block_domain}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
                {t.profile_cancel}
              </button>
            </div>
          </form>
        )}
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_loading_blocked}</div>
      ) : blocks.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_no_blocked}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_domain}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_severity}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_reason}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_blocked}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_actions}</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.domain} style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                  onMouseOver={(e) => (e.currentTarget as HTMLElement).style.background = "var(--accent-bg)"}
                  onMouseOut={(e) => (e.currentTarget as HTMLElement).style.background = ""}
                >
                  <td style={{ padding: "0.625rem 0.75rem", fontWeight: 600 }}>{b.domain}</td>
                  <td style={{ padding: "0.625rem 0.75rem" }}>
                    <span className="badge" style={{ background: b.severity === "suspend" ? "rgba(248,113,113,0.12)" : "rgba(251,191,36,0.12)", color: b.severity === "suspend" ? "var(--danger)" : "var(--warning)" }}>
                      {b.severity === "suspend" ? t.admin_severity_suspended : t.admin_severity_silenced}
                    </span>
                  </td>
                  <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", maxWidth: 280 }}>
                    {b.private_comment || <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </td>
                  <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {formatDate(b.created_at)}
                  </td>
                  <td style={{ padding: "0.625rem 0.75rem", textAlign: "right" }}>
                    <button
                      className="btn btn-outline btn-sm"
                      disabled={actionLoading === b.domain}
                      onClick={() => unblock(b.domain)}
                    >
                      {actionLoading === b.domain ? "..." : t.admin_btn_unblock}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
