"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";

interface AdminAccount {
  id: string;
  username: string;
  domain: string;
  created_at: string;
  email: string | null;
  role: string;
  confirmed: boolean;
  suspended: boolean;
  approved: boolean;
  account: {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
  };
}

interface ListResponse {
  accounts: AdminAccount[];
  total: number;
}

export default function AdminAccountsPage() {
  const router = useRouter();
  const token = getToken();

  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (search) params.set("q", search);
    params.set("limit", "80");

    try {
      const res = await fetch(`/api/v1/admin/accounts?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      const data = await res.json() as ListResponse;
      setAccounts(data.accounts);
      setTotal(data.total);
    } catch {
      router.push("/login");
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, search, roleFilter, statusFilter]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  async function performAction(id: string, action: string) {
    if (!token) return;
    setActionLoading(`${id}:${action}`);
    try {
      await fetch(`/api/v1/admin/accounts/${id}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      await fetchAccounts();
    } catch { /* ignore */ }
    setActionLoading(null);
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>
        Accounts
        <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
          ({total})
        </span>
      </h1>

      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          placeholder="Search by username..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 280, padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
        />
        <select
          className="input"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          style={{ width: "auto", padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
        >
          <option value="all">All roles</option>
          <option value="admin">Admin</option>
          <option value="moderator">Moderator</option>
          <option value="user">User</option>
        </select>
        <select
          className="input"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ width: "auto", padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
        >
          <option value="all">All status</option>
          <option value="active">Active</option>
          <option value="pending">Pending</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>Loading accounts...</div>
      ) : accounts.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>No accounts found.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>Account</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>Role</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>Status</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>Created</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const isBusy = actionLoading === `${a.id}:approve` || actionLoading === `${a.id}:suspend` || actionLoading === `${a.id}:unsuspend` || actionLoading === `${a.id}:promote` || actionLoading === `${a.id}:demote`;
                return (
                  <tr key={a.id} style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                    onMouseOver={(e) => (e.currentTarget as HTMLElement).style.background = "var(--accent-bg)"}
                    onMouseOut={(e) => (e.currentTarget as HTMLElement).style.background = ""}
                  >
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
                        <div
                          className="avatar"
                          style={{ width: 34, height: 34, background: "var(--bg-overlay)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)" }}
                        >
                          {(a.account.display_name?.[0] ?? a.username[0]).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{a.account.display_name || a.username}</div>
                          <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>@{a.account.acct}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      <RoleBadge role={a.role} />
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      {a.suspended ? (
                        <span className="badge" style={{ background: "rgba(248,113,113,0.12)", color: "var(--danger)" }}>Suspended</span>
                      ) : !a.confirmed ? (
                        <span className="badge" style={{ background: "rgba(251,191,36,0.12)", color: "var(--warning)" }}>Pending</span>
                      ) : (
                        <span className="badge badge-success">Active</span>
                      )}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                      {formatDate(a.created_at)}
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "0.375rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
                        {!a.confirmed && (
                          <button className="btn btn-primary btn-sm" disabled={isBusy} onClick={() => performAction(a.id, "approve")}>
                            {isBusy && actionLoading === `${a.id}:approve` ? "..." : "Approve"}
                          </button>
                        )}
                        {a.suspended ? (
                          <button className="btn btn-outline btn-sm" disabled={isBusy} onClick={() => performAction(a.id, "unsuspend")}>
                            {isBusy && actionLoading === `${a.id}:unsuspend` ? "..." : "Unsuspend"}
                          </button>
                        ) : a.confirmed && (
                          <button className="btn btn-outline btn-sm" disabled={isBusy} onClick={() => performAction(a.id, "suspend")} style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>
                            {isBusy && actionLoading === `${a.id}:suspend` ? "..." : "Suspend"}
                          </button>
                        )}
                        {a.role === "user" && (
                          <button className="btn btn-outline btn-sm" disabled={isBusy} onClick={() => performAction(a.id, "promote")}>
                            {isBusy && actionLoading === `${a.id}:promote` ? "..." : "Promote"}
                          </button>
                        )}
                        {(a.role === "moderator" || a.role === "admin") && (
                          <button className="btn btn-ghost btn-sm" disabled={isBusy} onClick={() => performAction(a.id, "demote")}>
                            {isBusy && actionLoading === `${a.id}:demote` ? "..." : "Demote"}
                          </button>
                        )}
                      </div>
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

function RoleBadge({ role }: { role: string }) {
  const style: React.CSSProperties = {
    padding: "0.2rem 0.55rem",
    borderRadius: "9999px",
    fontSize: "0.72rem",
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
  };

  if (role === "admin") {
    return <span style={{ ...style, background: "rgba(99,102,241,0.12)", color: "var(--accent)" }}>Admin</span>;
  }
  if (role === "moderator") {
    return <span style={{ ...style, background: "rgba(52,211,153,0.12)", color: "var(--success)" }}>Moderator</span>;
  }
  return <span style={{ ...style, background: "var(--bg-elevated)", color: "var(--text-secondary)" }}>User</span>;
}
