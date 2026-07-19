"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getToken } from "@/lib/client-api";

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
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<number | null>(null);
  const [reportedCount, setReportedCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) { router.push("/login"); return; }

    const headers = { Authorization: `Bearer ${token}` };

    Promise.all([
      fetch("/api/v1/admin/accounts?limit=1", { headers }).then(async (r) => {
        const data = await r.json() as { total: number; accounts: AccountSummary[] };
        setTotalUsers(data.total);
        return data.total;
      }),
      fetch("/api/v1/admin/accounts?status=pending&limit=1", { headers }).then(async (r) => {
        const data = await r.json() as { total: number };
        setPendingApprovals(data.total);
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
      <div style={{ color: "var(--text-muted)", padding: "2rem" }}>Loading dashboard...</div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Dashboard</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <StatCard label="Total users" value={totalUsers ?? 0} />
        <StatCard label="Pending approvals" value={pendingApprovals ?? 0} accent />
        <StatCard label="Open reports" value={reportedCount ?? 0} danger={!!reportedCount && reportedCount > 0} />
      </div>
      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Link href="/admin/accounts" className="btn btn-primary">
          Manage Accounts
        </Link>
        <Link href="/admin/reports" className="btn btn-outline">
          View Reports
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
