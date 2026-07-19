"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";

interface Account {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
  note: string;
  followers_count: number;
  statuses_count: number;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function EndorsementsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [endorsed, setEndorsed] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [unendorsingId, setUnendorsingId] = useState<string | null>(null);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchEndorsements();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchEndorsements() {
    if (!token) return;
    setLoading(true);
    const res = await fetch("/api/v1/endorsements", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setEndorsed(await res.json() as Account[]);
    setLoading(false);
  }

  async function handleUnendorse(account: Account) {
    if (!token) return;
    setUnendorsingId(account.id);
    const res = await fetch(`/api/v1/accounts/${encodeURIComponent(account.id)}/unpin`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setEndorsed((prev) => prev.filter((a) => a.id !== account.id));
    setUnendorsingId(null);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/endorsements" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">Endorsements</h1>
        </div>
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : endorsed.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>⭐</div>
            <div style={{ fontWeight: 600 }}>No endorsements yet</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
              Pin accounts you recommend to see them here.
            </div>
          </div>
        ) : (
          endorsed.map((account) => {
            const isRemote = account.acct.includes("@");
            const profileHref = isRemote
              ? `/users/remote?url=${encodeURIComponent(account.id)}`
              : `/users/${account.username}`;
            return (
              <div
                key={account.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.875rem",
                  padding: "0.875rem 1rem",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <Link href={profileHref} style={{ flexShrink: 0 }}>
                  {account.avatar ? (
                    <img
                      src={account.avatar}
                      alt=""
                      className="avatar"
                      style={{ width: 46, height: 46 }}
                    />
                  ) : (
                    <div
                      className="avatar"
                      style={{
                        width: 46, height: 46,
                        background: "var(--accent-bg)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontWeight: 700, color: "var(--accent)", fontSize: "1.1rem",
                      }}
                    >
                      {(account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase()}
                    </div>
                  )}
                </Link>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                    <Link
                      href={profileHref}
                      style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)", textDecoration: "none" }}
                    >
                      {account.display_name || account.username}
                    </Link>
                  </div>
                  <div style={{ fontSize: "0.82rem", color: "var(--text-muted)" }}>
                    @{account.acct}
                  </div>
                  {account.note && (
                    <div
                      style={{
                        fontSize: "0.82rem",
                        color: "var(--text-secondary)",
                        marginTop: "0.3rem",
                        overflow: "hidden",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                      dangerouslySetInnerHTML={{ __html: account.note }}
                    />
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ flexShrink: 0, color: "var(--danger)" }}
                  disabled={unendorsingId === account.id}
                  onClick={() => void handleUnendorse(account)}
                >
                  {unendorsingId === account.id ? "…" : "Unendorse"}
                </button>
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
