"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { Loading } from "@/components/Loading";

interface DirectoryEntry {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
  followers_count: number;
  statuses_count: number;
  last_status_at: string;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function DirectoryPage() {
  const router = useRouter();
  const { t } = useLocale();
  const [me, setMe] = useState<Me | null>(null);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [local, setLocal] = useState(true);
  const [order, setOrder] = useState<"new" | "popular">("new");
  const token = getToken();

  useEffect(() => {
    async function fetchMe() {
      if (!token) return;
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }

    if (!token) { router.push("/login"); return; }
    void fetchMe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    async function fetchDirectory() {
      if (!token) return;
      setLoading(true);
      const params = new URLSearchParams({ local: String(local), order });
      const res = await fetch(`/api/v1/directory?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setEntries(await res.json() as DirectoryEntry[]);
      setLoading(false);
    }

    void fetchDirectory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, order]);

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/directory" />}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", zIndex: 10 }}>
          <div style={{ padding: "1rem 1rem 0.5rem" }}>
            <h1 className="text-lg font-bold">{t.directory_title}</h1>
          </div>
          <div style={{ display: "flex", padding: "0 1rem 0.75rem", gap: "0.5rem" }}>
            <div style={{ display: "flex", borderRadius: "var(--radius)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <button
                type="button"
                className="btn btn-sm"
                style={{
                  borderRadius: 0,
                  background: local ? "var(--accent)" : "transparent",
                  color: local ? "#fff" : "var(--text-secondary)",
                  border: "none",
                }}
                onClick={() => setLocal(true)}
              >
                {t.timeline_local}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{
                  borderRadius: 0,
                  background: !local ? "var(--accent)" : "transparent",
                  color: !local ? "#fff" : "var(--text-secondary)",
                  border: "none",
                }}
                onClick={() => setLocal(false)}
              >
                {t.directory_all}
              </button>
            </div>
            <div style={{ display: "flex", borderRadius: "var(--radius)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <button
                type="button"
                className="btn btn-sm"
                style={{
                  borderRadius: 0,
                  background: order === "new" ? "var(--accent)" : "transparent",
                  color: order === "new" ? "#fff" : "var(--text-secondary)",
                  border: "none",
                }}
                onClick={() => setOrder("new")}
              >
                {t.directory_new}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                style={{
                  borderRadius: 0,
                  background: order === "popular" ? "var(--accent)" : "transparent",
                  color: order === "popular" ? "#fff" : "var(--text-secondary)",
                  border: "none",
                }}
                onClick={() => setOrder("popular")}
              >
                {t.directory_popular}
              </button>
            </div>
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : entries.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}><Icon name="users" size="2rem" /></div>
            <div style={{ fontWeight: 600 }}>{t.directory_empty}</div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "0.75rem", padding: "0.75rem" }}>
            {entries.map((entry) => {
              const profileHref = entry.acct.includes("@")
                ? `/users/remote?url=${encodeURIComponent(entry.id)}`
                : `/users/${entry.username}`;
              return (
                <Link
                  key={entry.id}
                  href={profileHref}
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div
                    className="card"
                    style={{
                      padding: "1rem",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: "0.625rem",
                      textAlign: "center",
                      transition: "transform 0.1s, box-shadow 0.15s",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-2px)";
                      e.currentTarget.style.boxShadow = "var(--shadow-lg)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "";
                      e.currentTarget.style.boxShadow = "";
                    }}
                  >
                    {entry.avatar ? (
                      <Image
                        src={entry.avatar}
                        alt=""
                        className="avatar"
                        width={56}
                        height={56}
                        style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
                      />
                    ) : (
                      <div
                        className="avatar"
                        style={{
                          width: 56, height: 56,
                          background: "var(--accent-bg)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontWeight: 700, color: "var(--accent)", fontSize: "1.25rem",
                        }}
                      >
                        {(entry.display_name?.[0] ?? entry.username?.[0] ?? "?").toUpperCase()}
                      </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {entry.display_name || entry.username}
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                        @{entry.acct}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "1rem", fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
                      <span><strong style={{ color: "var(--text)" }}>{entry.followers_count}</strong> {t.profile_followers}</span>
                      <span><strong style={{ color: "var(--text)" }}>{entry.statuses_count}</strong> {t.profile_posts}</span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
    </PageLayout>
  );
}
