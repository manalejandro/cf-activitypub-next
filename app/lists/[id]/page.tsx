"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { StatusCard, type Status } from "@/components/StatusCard";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";

interface List {
  id: string;
  title: string;
  replies_policy: string;
}

interface Account {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

type ActiveTab = "members" | "timeline";

export default function ListDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [me, setMe] = useState<Me | null>(null);
  const [list, setList] = useState<List | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [addAcct, setAddAcct] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("members");
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    if (!token || !params?.id) { router.push("/login"); return; }
    void fetchMe();
    void fetchList();
    void fetchAccounts();
    void fetchTimeline();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchList() {
    if (!token || !params?.id) return;
    const res = await fetch(`/api/v1/lists/${encodeURIComponent(params.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setList(await res.json() as List);
  }

  async function fetchAccounts() {
    if (!token || !params?.id) return;
    const res = await fetch(`/api/v1/lists/${encodeURIComponent(params.id)}/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setAccounts(await res.json() as Account[]);
    setLoading(false);
  }

  async function fetchTimeline() {
    if (!token || !params?.id) return;
    const res = await fetch(`/api/v1/timelines/list?list_id=${encodeURIComponent(params.id)}&limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setStatuses(await res.json() as Status[]);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !addAcct.trim() || !params?.id) return;
    setAdding(true);
    const res = await fetch(`/api/v1/lists/${encodeURIComponent(params.id)}/accounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ account_ids: [addAcct.trim()] }),
    });
    if (res.ok) {
      setAddAcct("");
      void fetchAccounts();
    }
    setAdding(false);
  }

  async function handleRemove(account: Account) {
    if (!token || !params?.id) return;
    setRemovingId(account.id);
    await fetch(`/api/v1/lists/${encodeURIComponent(params.id)}/accounts`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ account_ids: [account.id] }),
    });
    setAccounts((prev) => prev.filter((a) => a.id !== account.id));
    setRemovingId(null);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/lists" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "0.75rem 1rem", zIndex: 10, display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => router.push("/lists")}>←</button>
          <h1 className="text-lg font-bold">{list?.title || t.lists_title}</h1>
        </div>

        <div className="flex" style={{ borderBottom: "1px solid var(--border)" }}>
          {(["members", "timeline"] as ActiveTab[]).map((tab) => (
            <button
              key={tab}
              className="btn btn-ghost"
              onClick={() => setActiveTab(tab)}
              style={{
                flex: 1,
                borderRadius: 0,
                padding: "0.75rem 1rem",
                borderBottom: activeTab === tab ? "2px solid var(--accent)" : "2px solid transparent",
                color: activeTab === tab ? "var(--accent)" : "var(--text-muted)",
                fontWeight: activeTab === tab ? 600 : 400,
                fontSize: "0.875rem",
              }}
            >
              {tab === "members" ? t.lists_members : t.lists_timeline}
            </button>
          ))}
        </div>

        {activeTab === "members" && (
          <>
            <form onSubmit={(e) => void handleAdd(e)} style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", display: "flex", gap: "0.5rem" }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder={t.lists_add_account + " (ID)"}
                value={addAcct}
                onChange={(e) => setAddAcct(e.target.value)}
                disabled={adding}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={!addAcct.trim() || adding}>
                {adding ? "…" : "+"}
              </button>
            </form>

            {loading ? (
              <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
            ) : accounts.length === 0 ? (
              <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
                <div style={{ fontWeight: 600 }}>{t.lists_no_accounts}</div>
              </div>
            ) : (
              accounts.map((account) => (
                <div key={account.id} className="flex items-center gap-3" style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
                  <Link href={`/users/${account.acct.includes("@") ? "remote?url=" + encodeURIComponent(account.id) : account.username}`} style={{ display: "flex", alignItems: "center", gap: "0.75rem", flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
                    <div className="avatar" style={{ width: 36, height: 36, flexShrink: 0, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", fontWeight: 700, color: "var(--accent)", fontSize: "0.9rem" }}>
                      {(account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div style={{ fontWeight: 600, fontSize: "0.875rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{account.display_name || account.username}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>@{account.acct}</div>
                    </div>
                  </Link>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: "var(--danger)", flexShrink: 0 }}
                    onClick={() => void handleRemove(account)}
                    disabled={removingId === account.id}
                  >
                    {removingId === account.id ? "…" : t.lists_remove_account}
                  </button>
                </div>
              ))
            )}
          </>
        )}

        {activeTab === "timeline" && (
          statuses.length === 0 ? (
            <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
              <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}>📭</div>
              <div>{t.timeline_empty}</div>
            </div>
          ) : (
            statuses.map((s) => (
              <StatusCard
                key={s.id}
                status={s}
                onFav={() => {}}
                onReblog={() => {}}
                onReply={() => {}}
                me={me}
              />
            ))
          )
        )}
      </main>
    </div>
  );
}
