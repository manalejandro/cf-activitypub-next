"use client";

import i18next from "i18next";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { Pagination } from "@/components/Pagination";

interface InstanceMeta {
  domain: string;
  software: string | null;
  version: string | null;
  title: string | null;
  languages: string[];
  lastSeenAt: string;
  metadataUpdatedAt: string | null;
  failureDays: number;
  unavailable: boolean;
  lastFailureAt: string | null;
  lastOkAt: string | null;
  lastStatus: number | null;
  suspended: boolean;
}

interface AdminInstance {
  instance: InstanceMeta;
  accounts: number;
  localFollows: number;
  followers: number;
  blocked: boolean;
  dormant: boolean;
}

const PAGE_LIMIT = 40;

export default function AdminInstancesPage() {
  const router = useRouter();
  const { t } = useLocale();
  const token = getToken();

  const [rows, setRows] = useState<AdminInstance[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);

  const [adding, setAdding] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchInstances = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT), status, page: String(page) });
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(`/api/v1/admin/instances?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      const data = await res.json() as { instances: AdminInstance[]; total: number };
      setRows(data.instances);
      setTotal(data.total);
    } catch {
      router.push("/login");
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, query, status, page]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchInstances());
  }, [fetchInstances]);

  function flash(key: string) {
    setNotice(t[key as keyof typeof t] as string);
    window.setTimeout(() => setNotice(null), 3000);
  }

  async function action(domain: string, act: string) {
    if (!token || actionLoading) return;
    setActionLoading(domain);
    try {
      const res = await fetch("/api/v1/admin/instances", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain, action: act }),
      });
      if (res.status === 401) { router.push("/login"); return; }
      const data = await res.json().catch(() => ({})) as { ok?: boolean };
      if (act === "refresh" || act === "add") {
        flash(data.ok ? "admin_instances_refresh_ok" : "admin_instances_refresh_fail");
      }
      await fetchInstances();
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  async function purge(domain: string) {
    if (!token || actionLoading) return;
    if (!window.confirm(t.admin_instances_purge_confirm)) return;
    setActionLoading(domain);
    try {
      await fetch(`/api/v1/admin/instances?domain=${encodeURIComponent(domain)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchInstances();
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const domain = newDomain.trim().toLowerCase();
    if (!token || !domain || busy) return;
    setBusy(true);
    setActionLoading(domain);
    try {
      const res = await fetch("/api/v1/admin/instances", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ domain, action: "add" }),
      });
      if (res.status === 401) { router.push("/login"); return; }
      const data = await res.json().catch(() => ({})) as { ok?: boolean };
      flash(data.ok ? "admin_instances_added" : "admin_instances_refresh_fail");
      setNewDomain("");
      setAdding(false);
      await fetchInstances();
    } catch { /* ignore */ }
    setBusy(false);
    setActionLoading(null);
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString(i18next.language || "en", {
      year: "numeric", month: "short", day: "numeric",
    });
  }

  function statusOf(meta: InstanceMeta, dormant: boolean): { key: string; color: string; bg: string } {
    if (meta.suspended) return { key: "admin_instances_status_suspended", color: "var(--danger)", bg: "rgba(248,113,113,0.12)" };
    if (meta.unavailable) return { key: "admin_instances_status_unavailable", color: "var(--warning)", bg: "rgba(251,191,36,0.12)" };
    if (dormant) return { key: "admin_instances_status_dormant", color: "var(--text-muted)", bg: "var(--bg-elevated)" };
    return { key: "admin_instances_status_ok", color: "var(--success)", bg: "rgba(74,222,128,0.12)" };
  }

  const statusFilters = [
    { value: "all", key: "admin_instances_filter_all" },
    { value: "ok", key: "admin_instances_filter_ok" },
    { value: "unavailable", key: "admin_instances_filter_unavailable" },
    { value: "blocked", key: "admin_instances_filter_blocked" },
    { value: "dormant", key: "admin_instances_filter_dormant" },
    { value: "suspended", key: "admin_instances_filter_suspended" },
  ];

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        <Icon name="globe" /> {t.admin_instances}
        <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
          ({total})
        </span>
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
        {t.admin_instances_desc}
      </p>

      {notice && (
        <div style={{ marginBottom: "1rem", padding: "0.5rem 0.75rem", borderRadius: "var(--radius-sm)", background: "var(--accent-bg)", color: "var(--accent)", fontSize: "0.85rem" }}>
          {notice}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <input
          className="input"
          style={{ maxWidth: 280 }}
          placeholder={t.admin_instances_search_ph}
          aria-label={t.admin_instances_search_ph}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
        />
        <select
          className="input"
          style={{ maxWidth: 200 }}
          aria-label={t.admin_col_status}
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
        >
          {statusFilters.map((f) => (
            <option key={f.value} value={f.value}>{t[f.key as keyof typeof t] as string}</option>
          ))}
        </select>
        {!adding ? (
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            {t.admin_instances_add}
          </button>
        ) : (
          <form onSubmit={(e) => void handleAdd(e)} style={{ display: "flex", gap: "0.5rem", flex: 1, minWidth: 280 }}>
            <input
              className="input"
              placeholder={t.admin_instances_add_ph}
              aria-label={t.admin_instances_add_ph}
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={!newDomain.trim() || busy}>
              {busy ? "…" : t.admin_instances_add}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(false)}>
              {t.profile_cancel}
            </button>
          </form>
        )}
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_instances_loading}</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_instances_empty}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_domain}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_instances_col_software}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_instances_col_accounts}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_instances_col_follows}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_instances_col_followers}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_status}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_instances_col_last_seen}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_actions}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ instance, accounts, localFollows, followers, blocked, dormant }) => {
                const badge = statusOf(instance, dormant);
                const busyRow = actionLoading === instance.domain;
                return (
                  <tr key={instance.domain} style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                    onMouseOver={(e) => (e.currentTarget as HTMLElement).style.background = "var(--accent-bg)"}
                    onMouseOut={(e) => (e.currentTarget as HTMLElement).style.background = ""}
                  >
                    <td style={{ padding: "0.625rem 0.75rem", fontWeight: 600 }}>
                      <a href={`https://${instance.domain}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text)" }}>
                        {instance.domain}
                      </a>
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)" }}>
                      {instance.software
                        ? `${instance.software}${instance.version ? ` ${instance.version}` : ""}`
                        : <span style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", color: "var(--text-secondary)" }}>{accounts}</td>
                    <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", color: "var(--text-secondary)" }}>{localFollows}</td>
                    <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", color: "var(--text-secondary)" }}>{followers}</td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      <span className="badge" style={{ background: badge.bg, color: badge.color }}>
                        {t[badge.key as keyof typeof t] as string}
                      </span>
                      {blocked && (
                        <span className="badge" style={{ marginLeft: "0.35rem", background: "rgba(248,113,113,0.12)", color: "var(--danger)" }}>
                          {t.admin_blocked_title}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                      {formatDate(instance.lastSeenAt)}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn btn-outline btn-sm" style={{ marginRight: "0.35rem" }}
                        disabled={busyRow} onClick={() => void action(instance.domain, "refresh")}
                        title={t.admin_instances_btn_refresh}>
                        <Icon name="refresh" />
                      </button>
                      {instance.unavailable && (
                        <button className="btn btn-outline btn-sm" style={{ marginRight: "0.35rem" }}
                          disabled={busyRow} onClick={() => void action(instance.domain, "reset")}
                          title={t.admin_instances_btn_reset}>
                          <Icon name="check" />
                        </button>
                      )}
                      <button className="btn btn-outline btn-sm" style={{ marginRight: "0.35rem" }}
                        disabled={busyRow}
                        onClick={() => void action(instance.domain, instance.suspended ? "unsuspend" : "suspend")}>
                        {instance.suspended ? t.admin_instances_btn_unsuspend : t.admin_instances_btn_suspend}
                      </button>
                      <button className="btn btn-danger btn-sm"
                        disabled={busyRow} onClick={() => void purge(instance.domain)}>
                        {t.admin_instances_btn_purge}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!loading && <Pagination page={page} pages={Math.max(1, Math.ceil(total / PAGE_LIMIT))} onPageChange={setPage} />}
    </div>
  );
}
