"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/Avatar";

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

export default function MutesPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [muted, setMuted] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [unmutingId, setUnmutingId] = useState<string | null>(null);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    async function fetchMe() {
      if (!token) return;
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }

    async function fetchMuted() {
      if (!token) return;
      setLoading(true);
      const res = await fetch("/api/v1/mutes", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMuted(await res.json() as Account[]);
      setLoading(false);
    }

    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchMuted();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUnmute(account: Account) {
    if (!token) return;
    setUnmutingId(account.id);
    await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/unmute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setMuted((prev) => prev.filter((a) => a.id !== account.id));
    setUnmutingId(null);
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/mutes" />}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">{t.mutes_title}</h1>
        </div>
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : muted.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}><Icon name="microphone-slash" size="2rem" /></div>
            <div style={{ fontWeight: 600 }}>{t.mutes_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.mutes_empty_sub}</div>
          </div>
        ) : (
          muted.map((account) => (
            <div key={account.id} className="flex items-center gap-3" style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
              <Link href={`/users/${account.acct.includes("@") ? "remote?url=" + encodeURIComponent(account.id) : account.username}`}>
                <Avatar avatar={account.avatar} name={account.display_name || account.username} size={40} />
              </Link>
              <div className="flex-1 min-w-0">
                <Link href={`/users/${account.acct.includes("@") ? "remote?url=" + encodeURIComponent(account.id) : account.username}`} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
                  {account.display_name || account.username}
                </Link>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{account.acct}</div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                style={{ flexShrink: 0 }}
                onClick={() => void handleUnmute(account)}
                disabled={unmutingId === account.id}
              >
                {unmutingId === account.id ? "…" : t.mutes_unmute}
              </button>
            </div>
          ))
        )}
    </PageLayout>
  );
}
