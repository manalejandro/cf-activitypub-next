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

export default function AdminDashboard() {
  const router = useRouter();
  const { t } = useLocale();
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<number | null>(null);
  const [federatedAccounts, setFederatedAccounts] = useState<number | null>(null);
  const [reportedCount, setReportedCount] = useState<number | null>(null);
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
    ]).catch(() => {})
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Link href="/admin/accounts" className="btn btn-primary">
          <Icon name="users" color="#fff" /> {t.admin_accounts}
        </Link>
        <Link href="/admin/reports" className="btn btn-outline">
          <Icon name="flag" /> {t.admin_reports}
        </Link>
      </div>
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
