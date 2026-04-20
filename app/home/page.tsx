"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";

interface Account {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
}

interface Status {
  id: string;
  content: string;
  created_at: string;
  account: Account;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  favourited: boolean;
  reblogged: boolean;
}

export default function HomePage() {
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [me, setMe] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState("");
  const [posting, setPosting] = useState(false);
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;

  useEffect(() => {
    if (!token) { window.location.href = "/login"; return; }
    void fetchTimeline();
    void fetchMe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchTimeline() {
    if (!token) return;
    const res = await fetch("/api/api/v1/timelines/home", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setStatuses(await res.json() as Status[]);
    setLoading(false);
  }

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Account);
  }

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    if (!composing.trim() || !token) return;
    setPosting(true);
    const res = await fetch("/api/api/v1/statuses", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: composing }),
    });
    if (res.ok) {
      setComposing("");
      await fetchTimeline();
    }
    setPosting(false);
  }

  async function toggleFavourite(s: Status) {
    if (!token) return;
    const path = s.favourited ? "unfavourite" : "favourite";
    const res = await fetch(`/api/api/v1/statuses/${s.id}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setStatuses((prev) =>
        prev.map((x) =>
          x.id === s.id
            ? { ...x, favourited: !s.favourited, favourites_count: s.favourites_count + (s.favourited ? -1 : 1) }
            : x
        )
      );
    }
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    const now = Date.now();
    const diff = (now - d.getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString();
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg)" }}>
      {/* Sidebar */}
      <aside
        style={{
          width: 260,
          flexShrink: 0,
          padding: "1.5rem 1rem",
          borderRight: "1px solid var(--border)",
          position: "sticky",
          top: 0,
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
        className="hidden md:flex"
      >
        <Link href="/" className="flex items-center gap-2 px-2">
          <Image src="/logo.svg" alt="CF ActivityPub" width={32} height={32} />
          <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>CF ActivityPub</span>
        </Link>

        <nav className="flex flex-col gap-1">
          {[
            { label: "Home", icon: "🏠", href: "/home" },
            { label: "Explore", icon: "🌐", href: "/explore" },
            { label: "Notifications", icon: "🔔", href: "/notifications" },
            { label: "Profile", icon: "👤", href: me ? `/@${me.username}` : "/login" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="btn btn-ghost"
              style={{ justifyContent: "flex-start", gap: "0.75rem", padding: "0.625rem 0.875rem" }}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        {me && (
          <div
            style={{
              marginTop: "auto",
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.75rem",
              borderRadius: "var(--radius)",
              background: "var(--bg-elevated)",
            }}
          >
            <div
              className="avatar"
              style={{ width: 36, height: 36, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.2rem" }}
            >
              {me.display_name?.[0] ?? me.username?.[0] ?? "?"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: "0.875rem", overflow: "hidden", textOverflow: "ellipsis" }}>
                {me.display_name || me.username}
              </div>
              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>@{me.acct}</div>
            </div>
          </div>
        )}
      </aside>

      {/* Main feed */}
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        {/* Compose */}
        <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
          <form onSubmit={handlePost} className="flex flex-col gap-3">
            <textarea
              className="input"
              style={{ resize: "none", minHeight: 80, fontFamily: "inherit" }}
              placeholder="What's on your mind?"
              value={composing}
              onChange={(e) => setComposing(e.target.value)}
              maxLength={500}
            />
            <div className="flex items-center justify-between">
              <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                {composing.length}/500
              </span>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={posting || !composing.trim()}
              >
                {posting ? "Posting…" : "Post"}
              </button>
            </div>
          </form>
        </div>

        {/* Timeline */}
        {loading ? (
          <div className="flex flex-col gap-0">
            {[1, 2, 3].map((i) => (
              <div key={i} className="status-card flex gap-3" style={{ padding: "1rem" }}>
                <div className="skeleton" style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }} />
                <div className="flex flex-col gap-2 flex-1">
                  <div className="skeleton" style={{ height: 14, width: "40%" }} />
                  <div className="skeleton" style={{ height: 14, width: "80%" }} />
                  <div className="skeleton" style={{ height: 14, width: "60%" }} />
                </div>
              </div>
            ))}
          </div>
        ) : statuses.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center"
            style={{ padding: "4rem 2rem", color: "var(--text-muted)", textAlign: "center" }}
          >
            <span style={{ fontSize: "3rem", marginBottom: "1rem" }}>🌐</span>
            <p>Your timeline is empty.</p>
            <p style={{ fontSize: "0.875rem" }}>Follow people to see their posts here.</p>
          </div>
        ) : (
          statuses.map((s) => (
            <article key={s.id} className="status-card" style={{ display: "flex", gap: "0.875rem" }}>
              <div
                className="avatar"
                style={{
                  width: 42, height: 42, flexShrink: 0,
                  background: "var(--accent-bg)", display: "flex",
                  alignItems: "center", justifyContent: "center", fontSize: "1.2rem"
                }}
              >
                {s.account.display_name?.[0] ?? s.account.username?.[0] ?? "?"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-baseline gap-2" style={{ marginBottom: "0.3rem" }}>
                  <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                    {s.account.display_name || s.account.username}
                  </span>
                  <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    @{s.account.acct}
                  </span>
                  <span style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginLeft: "auto" }}>
                    {formatTime(s.created_at)}
                  </span>
                </div>
                <div
                  style={{ fontSize: "0.95rem", lineHeight: 1.55 }}
                  dangerouslySetInnerHTML={{ __html: s.content }}
                />
                <div className="flex gap-5 mt-3" style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
                  <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}>
                    💬 {s.replies_count}
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ padding: "0.2rem 0.4rem", gap: "0.35rem" }}>
                    🔁 {s.reblogs_count}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ padding: "0.2rem 0.4rem", gap: "0.35rem", color: s.favourited ? "var(--danger)" : "var(--text-muted)" }}
                    onClick={() => toggleFavourite(s)}
                  >
                    {s.favourited ? "❤️" : "🤍"} {s.favourites_count}
                  </button>
                </div>
              </div>
            </article>
          ))
        )}
      </main>
    </div>
  );
}
