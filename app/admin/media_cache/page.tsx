"use client";

import i18next from "i18next";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";

interface TopServedEntry {
  r2_key: string | null;
  target_type: string;
  size: number;
  hits: number;
  hits_at: string | null;
  last_hit_at: string | null;
}

interface MediaCacheMetrics {
  stats: {
    ready: number;
    pending: number;
    failed: number;
    bytes: number;
    oldestFetchedAt: string | null;
  };
  top_served: TopServedEntry[];
  config: {
    enabled: boolean;
    days: number;
    profile_days: number;
    max_bytes: number;
    max_object_bytes: number;
    fetch_batch: number;
    user_agents: string[];
  };
}

const TYPE_KEYS: Record<string, keyof Translations> = {
  attachment: "admin_media_cache_type_attachment",
  avatar: "admin_media_cache_type_avatar",
  header: "admin_media_cache_type_header",
  card: "admin_media_cache_type_card",
  license: "admin_media_cache_type_license",
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** D1 stores `datetime('now')` as UTC without a zone: parse it as UTC. */
function parseDbDate(value: string | null): Date | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export default function AdminMediaCachePage() {
  const router = useRouter();
  const { t } = useLocale();
  const token = getToken();

  const [metrics, setMetrics] = useState<MediaCacheMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [purging, setPurging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch("/api/v1/accounts/verify_credentials", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null) as Promise<{ roles?: { name: string }[] } | null>)
      .then((me) => setIsAdmin((me?.roles?.[0]?.name ?? "").toLowerCase() === "admin"))
      .catch(() => setIsAdmin(false));
  }, [token]);

  const fetchMetrics = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/v1/admin/media_cache", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { router.push("/login"); return; }
      if (!res.ok) { setError(true); return; }
      setMetrics(await res.json() as MediaCacheMetrics);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchMetrics());
  }, [fetchMetrics]);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 4000);
  }

  async function handlePurge() {
    if (!token || purging || !window.confirm(t.admin_media_cache_purge_confirm)) return;
    setPurging(true);
    try {
      const res = await fetch("/api/v1/admin/media_cache", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { router.push("/login"); return; }
      if (res.status === 403) { flash(t.admin_media_cache_purge_admin_only); return; }
      if (!res.ok) { flash(t.admin_media_cache_error); return; }
      const payload = await res.json() as { removed?: number };
      flash(t.admin_media_cache_purge_done.replace("{count}", String(payload.removed ?? 0)));
      await fetchMetrics();
    } catch {
      flash(t.admin_media_cache_error);
    } finally {
      setPurging(false);
    }
  }

  function formatDate(value: string | null) {
    const date = parseDbDate(value);
    if (!date) return "—";
    return date.toLocaleString(i18next.language || "en", {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  const config = metrics?.config;

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        <Icon name="database" /> {t.admin_media_cache}
        {metrics && (
          <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
            ({metrics.stats.ready})
          </span>
        )}
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
        {t.admin_media_cache_desc}
      </p>

      {notice && (
        <div style={{ marginBottom: "1rem", padding: "0.5rem 0.75rem", borderRadius: "var(--radius-sm)", background: "var(--accent-bg)", color: "var(--accent)", fontSize: "0.85rem" }}>
          {notice}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
        <button className="btn btn-outline btn-sm" onClick={() => void fetchMetrics()} disabled={loading}>
          <Icon name="refresh" spin={loading} /> {t.admin_media_cache_refresh}
        </button>
        {isAdmin && config?.enabled && (
          <button className="btn btn-danger btn-sm" onClick={() => void handlePurge()} disabled={purging}>
            <Icon name="trash" color="#fff" /> {purging ? "…" : t.admin_media_cache_purge}
          </button>
        )}
      </div>

      {loading && !metrics ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_media_cache_loading}</div>
      ) : error && !metrics ? (
        <div style={{ color: "var(--danger)", padding: "2rem 0" }}>{t.admin_media_cache_error}</div>
      ) : !config?.enabled ? (
        <div className="card" style={{ padding: "1.25rem", color: "var(--text-muted)", fontSize: "0.9rem" }}>
          {t.admin_media_cache_disabled}
        </div>
      ) : metrics && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
            <StatCard label={t.admin_media_cache_stat_ready} value={metrics.stats.ready} />
            <StatCard label={t.admin_media_cache_stat_pending} value={metrics.stats.pending} accent={metrics.stats.pending > 0} />
            <StatCard label={t.admin_media_cache_stat_failed} value={metrics.stats.failed} danger={metrics.stats.failed > 0} />
            <StatCard label={t.admin_media_cache_stat_bytes} value={formatSize(metrics.stats.bytes)} />
            <StatCard label={t.admin_media_cache_stat_oldest} value={formatDate(metrics.stats.oldestFetchedAt)} small />
          </div>

          <div className="card" style={{ padding: "1.25rem", marginBottom: "1.5rem" }}>
            <h2 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>{t.admin_media_cache_config}</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.5rem 1.5rem" }}>
              <ConfigRow label={t.admin_media_cache_config_enabled} value={config.enabled ? t.admin_media_cache_config_yes : t.admin_media_cache_config_no} />
              <ConfigRow label={t.admin_media_cache_config_days} value={String(config.days)} />
              <ConfigRow label={t.admin_media_cache_config_profile_days} value={String(config.profile_days)} />
              <ConfigRow label={t.admin_media_cache_config_max_bytes} value={formatSize(config.max_bytes)} />
              <ConfigRow label={t.admin_media_cache_config_max_object} value={formatSize(config.max_object_bytes)} />
              <ConfigRow label={t.admin_media_cache_config_fetch_batch} value={String(config.fetch_batch)} />
            </div>
          </div>

          <div className="card" style={{ padding: "1.25rem" }}>
            <h2 style={{ fontSize: "1rem", marginBottom: "0.25rem" }}>{t.admin_media_cache_top}</h2>
            <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
              {t.admin_media_cache_top_desc}
            </p>
            {metrics.top_served.length === 0 ? (
              <div style={{ color: "var(--text-muted)", padding: "1rem 0", fontSize: "0.875rem" }}>
                {t.admin_media_cache_top_empty}
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                      <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_media_cache_col_resource}</th>
                      <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_media_cache_col_type}</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_media_cache_col_size}</th>
                      <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_media_cache_col_hits}</th>
                      <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_media_cache_col_last}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.top_served.map((entry, index) => {
                      // Plain anchors, never `next/link`/`<img>`: the metrics page
                      // must not prefetch or download the copy (that would count
                      // as a serve and evict-protect it); opening one is a choice.
                      const href = entry.r2_key ? `/api/media/${entry.r2_key}` : null;
                      const typeKey = TYPE_KEYS[entry.target_type];
                      return (
                        <tr key={`${entry.r2_key ?? "row"}-${index}`} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "0.625rem 0.75rem", maxWidth: 420 }}>
                            {href ? (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: "var(--accent)", fontSize: "0.8rem", wordBreak: "break-all" }}
                              >
                                {href}
                              </a>
                            ) : "—"}
                          </td>
                          <td style={{ padding: "0.625rem 0.75rem" }}>
                            <span className="badge" style={{ background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
                              {typeKey ? t[typeKey] : entry.target_type}
                            </span>
                          </td>
                          <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", whiteSpace: "nowrap" }}>{formatSize(entry.size)}</td>
                          <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", fontWeight: 600 }}>{entry.hits}</td>
                          <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                            {formatDate(entry.last_hit_at ?? entry.hits_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, accent, danger, small }: { label: string; value: string | number; accent?: boolean; danger?: boolean; small?: boolean }) {
  return (
    <div
      className="card"
      style={{
        padding: "1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.375rem",
        borderLeft: accent ? "3px solid var(--warning)" : danger ? "3px solid var(--danger)" : "3px solid var(--accent)",
      }}
    >
      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      <div style={{ fontSize: small ? "1rem" : "1.6rem", fontWeight: 700, lineHeight: 1.2 }}>{value}</div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", fontSize: "0.875rem", borderBottom: "1px solid var(--border)", paddingBottom: "0.375rem" }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
