"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { Loading } from "@/components/Loading";

interface AccountSummary {
  id: string;
  username: string;
  role: string;
  suspended: boolean;
  confirmed: boolean;
}

interface ReportSummary {
  id: string;
  action_taken: boolean;
}

interface StorageSummary {
  enabled: boolean;
  config: { days: number; max_bytes: number; prune_batch: number; size_batch: number };
  estimate: {
    bytes: number;
    rows: number;
    measuredAt: string | null;
    measuring: boolean;
    pendingRows: number;
    databaseBytes: number | null;
    effectiveBytes: number;
  };
  last_run: { at: string; objectsDeleted: number; activitiesDeleted: number; bytesFreed: number } | null;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

export default function AdminDashboard() {
  const router = useRouter();
  const { t } = useLocale();
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<number | null>(null);
  const [federatedAccounts, setFederatedAccounts] = useState<number | null>(null);
  const [reportedCount, setReportedCount] = useState<number | null>(null);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [pruning, setPruning] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) { router.push("/login"); return; }

    const headers = { Authorization: `Bearer ${token}` };

    Promise.all([
      fetch("/api/v1/admin/accounts?local=true&limit=1", { headers }).then(async (r) => {
        const data = await r.json() as { total: number; accounts: AccountSummary[] };
        setTotalUsers(data.total);
        return data.total;
      }),
      fetch("/api/v1/admin/accounts?status=pending&local=true&limit=1", { headers }).then(async (r) => {
        const data = await r.json() as { total: number };
        setPendingApprovals(data.total);
        return data.total;
      }),
      fetch("/api/v1/admin/accounts?remote=true&limit=1", { headers }).then(async (r) => {
        const data = await r.json() as { total: number };
        setFederatedAccounts(data.total);
        return data.total;
      }),
      fetch("/api/v1/admin/reports", { headers }).then(async (r) => {
        const data = await r.json() as ReportSummary[];
        setReportedCount(data.filter((r) => !r.action_taken).length);
        return data.length;
      }),
      fetch("/api/v1/admin/storage", { headers }).then(async (r) => {
        if (r.ok) setStorage(await r.json() as StorageSummary);
        return null;
      }),
    ]).catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runRetention = async () => {
    const token = getToken();
    if (!token || pruning) return;
    setPruning(true);
    try {
      const res = await fetch("/api/v1/admin/storage", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { estimate: StorageSummary["estimate"]; last_run: StorageSummary["last_run"] };
        setStorage((prev) => (prev ? { ...prev, estimate: data.estimate, last_run: data.last_run } : prev));
      }
    } finally {
      setPruning(false);
    }
  };

  if (loading) {
    return (
      <Loading />
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}><Icon name="bar-chart" /> {t.admin_dashboard}</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <StatCard label={t.admin_users} value={totalUsers ?? 0} />
        <StatCard label={t.admin_pending} value={pendingApprovals ?? 0} accent />
        <StatCard label={t.admin_federated} value={federatedAccounts ?? 0} />
        <StatCard label={t.admin_open_reports} value={reportedCount ?? 0} danger={!!reportedCount && reportedCount > 0} />
      </div>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "2rem" }}>
        <Link href="/admin/accounts" className="btn btn-primary">
          <Icon name="users" color="#fff" /> {t.admin_accounts}
        </Link>
        <Link href="/admin/reports" className="btn btn-outline">
          <Icon name="flag" /> {t.admin_reports}
        </Link>
      </div>

      {storage && (
        <div className="card" style={{ padding: "1.25rem", maxWidth: "42rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.5rem" }}>
            <strong style={{ fontSize: "0.95rem" }}>
              <Icon name="database" /> {t.admin_storage_title}
            </strong>
            {storage.enabled ? (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void runRetention()} disabled={pruning}>
                <Icon name={pruning ? "hourglass" : "trash"} spin={pruning} /> {pruning ? t.admin_storage_running : t.admin_storage_run}
              </button>
            ) : (
              <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{t.admin_storage_disabled}</span>
            )}
          </div>
          <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginBottom: "0.6rem" }}>{t.admin_storage_desc}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.82rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
              <span style={{ color: "var(--text-secondary)" }}>{t.admin_storage_database}</span>
              <strong>{storage.estimate.databaseBytes ? formatBytes(storage.estimate.databaseBytes) : t.admin_storage_unknown}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
              <span style={{ color: "var(--text-secondary)" }}>{t.admin_storage_prunable}</span>
              <strong>
                {/* The walk is bounded per cron tick: until a pass finishes
                    there is no number yet, and "0 B" would be a lie. */}
                {storage.estimate.bytes > 0 || !storage.estimate.measuring
                  ? formatBytes(storage.estimate.bytes)
                  : `${t.admin_storage_measuring} (${storage.estimate.pendingRows.toLocaleString()})`}
              </strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
              <span style={{ color: "var(--text-secondary)" }}>{t.admin_storage_retention}</span>
              <strong>
                {storage.config.days > 0
                  ? t.admin_storage_days.replace("{days}", String(storage.config.days))
                  : t.admin_storage_no_days}
                {storage.config.max_bytes > 0
                  ? ` · ${t.admin_storage_max_bytes.replace("{size}", formatBytes(storage.config.max_bytes))}`
                  : ""}
              </strong>
            </div>
            {storage.last_run && (
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                <span style={{ color: "var(--text-secondary)" }}>{t.admin_storage_last_run}</span>
                <strong>
                  {new Date(storage.last_run.at).toLocaleString()} · {storage.last_run.objectsDeleted + storage.last_run.activitiesDeleted}{" "}
                  {t.admin_storage_deleted} · {formatBytes(storage.last_run.bytesFreed)}
                </strong>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent, danger }: { label: string; value: string | number; accent?: boolean; danger?: boolean }) {
  return (
    <div
      className="card"
      style={{
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.375rem",
        borderLeft: accent ? "3px solid var(--warning)" : danger ? "3px solid var(--danger)" : "3px solid var(--accent)",
      }}
    >
      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </div>
      <div style={{ fontSize: "2rem", fontWeight: 700, lineHeight: 1 }}>
        {value}
      </div>
    </div>
  );
}
