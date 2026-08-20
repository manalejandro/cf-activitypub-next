"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";

interface SuspendedAccount {
  id: string;
  username: string;
  domain: string;
  created_at: string;
  suspended: boolean;
  account: {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    avatar: string;
  };
}

interface ListResponse {
  accounts: SuspendedAccount[];
  total: number;
}

export default function AdminSuspendedPage() {
  const router = useRouter();
  const { t } = useLocale();
  const token = getToken();

  const [accounts, setAccounts] = useState<SuspendedAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams();
    params.set("status", "suspended");
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
  }, [token, search]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchAccounts());
  }, [fetchAccounts]);

  async function unsuspend(id: string) {
    if (!token) return;
    setActionLoading(id);
    try {
      await fetch(`/api/v1/admin/accounts/${encodeURIComponent(id)}/unsuspend`, {
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
        <Icon name="ban" /> {t.admin_suspended}
        <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
          ({total})
        </span>
      </h1>

      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="input"
          placeholder={t.admin_search_username}
          aria-label={t.admin_search_username}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 280, padding: "0.5rem 0.75rem", fontSize: "0.85rem" }}
        />
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_loading_accounts}</div>
      ) : accounts.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_no_accounts}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_account}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_status}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_status_suspended}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_actions}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                  onMouseOver={(e) => (e.currentTarget as HTMLElement).style.background = "var(--accent-bg)"}
                  onMouseOut={(e) => (e.currentTarget as HTMLElement).style.background = ""}
                >
                  <td style={{ padding: "0.625rem 0.75rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
                      <div
                        className="avatar"
                        style={{ width: 34, height: 34, background: "var(--bg-overlay)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)", borderRadius: "50%", overflow: "hidden", flexShrink: 0 }}
                      >
                        {a.account.avatar && !a.account.avatar.includes("/avatars/original/missing.png") ? (
                          <Image src={a.account.avatar} alt="" width={34} height={34} style={{ objectFit: "cover", width: "100%", height: "100%" }} />
                        ) : (
                          (a.account.display_name?.[0] ?? a.username[0]).toUpperCase()
                        )}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600 }}>{a.account.display_name || a.username}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>@{a.account.acct}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: "0.625rem 0.75rem" }}>
                    <span className="badge" style={{ background: "rgba(248,113,113,0.12)", color: "var(--danger)" }}>{t.admin_status_suspended}</span>
                  </td>
                  <td style={{ padding: "0.625rem 0.75rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {formatDate(a.created_at)}
                  </td>
                  <td style={{ padding: "0.625rem 0.75rem", textAlign: "right" }}>
                    <button
                      className="btn btn-outline btn-sm"
                      disabled={actionLoading === a.id}
                      onClick={() => unsuspend(a.id)}
                    >
                      {actionLoading === a.id ? "..." : t.admin_btn_unsuspend}
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