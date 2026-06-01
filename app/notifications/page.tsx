"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";

interface Account {
  id: string;
  username: string;
  display_name: string;
  avatar: string;
  acct: string;
}

interface Notification {
  id: string;
  type: "follow" | "follow_request" | "mention" | "reblog" | "favourite" | "poll" | "update";
  created_at: string;
  account: Account;
  status?: {
    id: string;
    content: string;
  };
}

const NOTIF_LABELS: Record<string, { icon: string; key: string }> = {
  follow:         { icon: "👤", key: "notif_followed_you" },
  follow_request: { icon: "👤", key: "notif_follow_request" },
  mention:        { icon: "💬", key: "notif_mentioned" },
  reblog:         { icon: "🔁", key: "notif_boosted" },
  favourite:      { icon: "❤️", key: "notif_liked" },
  poll:           { icon: "📊", key: "notif_poll" },
  update:         { icon: "✏️",  key: "notif_edited" },
};

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [pendingRequests, setPendingRequests] = useState<Account[]>([]);
  const [me, setMe] = useState<Account | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { t } = useLocale();
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;

  async function fetchNotifications() {
    if (!token) return;
    const res = await fetch("/api/v1/notifications?limit=40", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setNotifications(await res.json() as Notification[]);
    setLoading(false);
  }

  async function fetchFollowRequests() {
    if (!token) return;
    const res = await fetch("/api/v1/follow_requests?limit=40", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setPendingRequests(await res.json() as Account[]);
  }

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Account);
  }

  function formatTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString();
  }

  function getProfileHref(account: Account) {
    return account.acct.includes("@")
      ? `/users/remote?url=${encodeURIComponent(account.id)}`
      : `/users/${account.username}`;
  }

  async function handleFollowRequestAction(notificationId: string | null, accountId: string, action: "accept" | "reject") {
    if (!token || pendingAction) return;
    const actionKey = notificationId ?? accountId;
    setPendingAction(actionKey);
    const res = await fetch(`/api/v1/follow_requests/${encodeURIComponent(accountId)}/${action}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      if (notificationId) {
        setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
      }
      setPendingRequests((prev) => prev.filter((a) => a.id !== accountId));
    }
    setPendingAction(null);
  }

  async function markAllRead() {
    if (!token) return;
    await fetch("/api/v1/notifications/clear", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  useEffect(() => {
    if (!token) { window.location.href = "/login"; return; }
    void fetchNotifications();
    void fetchFollowRequests();
    void fetchMe();
    void markAllRead();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/notifications" />

      {/* Main */}
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div style={{ padding: "1rem 1rem 0.5rem", borderBottom: "1px solid var(--border)" }}>
          <h1 style={{ fontWeight: 700, fontSize: "1.2rem" }}>{t.nav_notifications}</h1>
        </div>

        {loading ? (
          <div className="flex flex-col gap-0">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3" style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
                <div className="skeleton" style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }} />
                <div className="flex flex-col gap-2 flex-1">
                  <div className="skeleton" style={{ height: 14, width: "60%" }} />
                  <div className="skeleton" style={{ height: 14, width: "40%" }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {/* ── Pending follow requests (direct from follows table) ── */}
            {pendingRequests.length > 0 && (
              <div>
                <div style={{ padding: "0.6rem 1rem", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: "0.85rem", color: "var(--text-muted)" }}>
                  {t.notif_follow_requests_title}
                </div>
                {pendingRequests.map((account) => (
                  <div
                    key={account.id}
                    className="flex gap-3"
                    style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}
                  >
                    <div style={{ fontSize: "1.5rem", flexShrink: 0, width: 42, textAlign: "center", paddingTop: "0.1rem" }}>
                      👤
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="flex items-baseline gap-2" style={{ marginBottom: "0.25rem" }}>
                        <div
                          className="avatar"
                          style={{
                            width: 28, height: 28, flexShrink: 0,
                            background: "var(--accent-bg)",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            fontSize: "0.9rem", borderRadius: "50%",
                          }}
                        >
                          {account.display_name?.[0] ?? account.username?.[0] ?? "?"}
                        </div>
                        <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                          {account.display_name || account.username}
                        </span>
                        <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                          {t.notif_follow_request}
                        </span>
                      </div>
                      {token && (
                        <div className="flex gap-2" style={{ marginTop: "0.5rem" }}>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={pendingAction === account.id}
                            onClick={() => void handleFollowRequestAction(null, account.id, "accept")}
                          >
                            {t.notif_accept}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={pendingAction === account.id}
                            onClick={() => void handleFollowRequestAction(null, account.id, "reject")}
                          >
                            {t.notif_reject}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Regular notifications ── */}
            {notifications.length === 0 && pendingRequests.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center"
            style={{ padding: "4rem 2rem", color: "var(--text-muted)", textAlign: "center" }}
          >
            <span style={{ fontSize: "3rem", marginBottom: "1rem" }}>🔔</span>
            <p style={{ fontWeight: 600 }}>{t.notif_empty}</p>
            <p style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>
              {t.notif_empty_sub}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {notifications.map((n) => {
              const meta = NOTIF_LABELS[n.type] ?? { icon: "🔔", key: "" };
              const metaText = meta.key ? (t[meta.key as keyof typeof t] ?? n.type) : n.type;
              const accountHref = getProfileHref(n.account);
              return (
                <div
                  key={n.id}
                  className="flex gap-3"
                  style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}
                >
                  <div style={{ fontSize: "1.5rem", flexShrink: 0, width: 42, textAlign: "center", paddingTop: "0.1rem" }}>
                    {meta.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-baseline gap-2" style={{ marginBottom: "0.25rem" }}>
                      <Link href={accountHref} style={{ textDecoration: "none" }}>
                        <div
                          className="avatar"
                          style={{
                            width: 28,
                            height: 28,
                            flexShrink: 0,
                            background: "var(--accent-bg)",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "0.9rem",
                            borderRadius: "50%",
                          }}
                        >
                          {n.account.display_name?.[0] ?? n.account.username?.[0] ?? "?"}
                        </div>
                      </Link>
                      <Link href={accountHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
                        {n.account.display_name || n.account.username}
                      </Link>
                      <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                        {metaText}
                      </span>
                      <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: "auto" }}>
                        {formatTime(n.created_at)}
                      </span>
                    </div>
                    {n.status && (
                      <Link href={`/statuses/${encodeURIComponent(n.status.id)}`} style={{ textDecoration: "none" }}>
                        <div
                          style={{
                            fontSize: "0.85rem",
                            color: "var(--text-muted)",
                            marginTop: "0.25rem",
                            padding: "0.5rem 0.75rem",
                            background: "var(--bg-elevated)",
                            borderRadius: "var(--radius)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          dangerouslySetInnerHTML={{ __html: n.status.content }}
                        />
                      </Link>
                    )}
                    {n.type === "follow_request" && token && (
                      <div className="flex gap-2" style={{ marginTop: "0.5rem" }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={pendingAction === n.id}
                          onClick={() => void handleFollowRequestAction(n.id, n.account.id, "accept")}
                        >
                          {t.notif_accept}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={pendingAction === n.id}
                          onClick={() => void handleFollowRequestAction(n.id, n.account.id, "reject")}
                        >
                          {t.notif_reject}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
          </>
        )}
      </main>
    </div>
  );
}
