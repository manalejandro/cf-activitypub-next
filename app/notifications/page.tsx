"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { RichText } from "@/components/RichText";
import { DisplayName } from "@/components/DisplayName";
import { Avatar } from "@/components/Avatar";
import type { EmojiData } from "@/lib/emoji";
import { useLocale } from "@/lib/i18n";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { BackToTop } from "@/components/BackToTop";
import { Icon, type IconName } from "@/components/Icon";
import { useLimits } from "@/lib/limits-client";

interface Account {
  id: string;
  username: string;
  display_name: string;
  emojis?: EmojiData[];
  verified?: boolean;
  avatar: string;
  acct: string;
}

interface Notification {
  id: string;
  type: "follow" | "follow_request" | "mention" | "reblog" | "favourite" | "poll" | "update" | "direct" | "encrypted" | "quote";
  created_at: string;
  account: Account;
  status?: {
    id: string;
    content: string;
    filtered?: { filter: { id: string; title: string; filter_action: "warn" | "hide" | "blur"; context?: string[] }; keyword_matches?: string[]; status_matches?: string[] }[];
  };
}

const NOTIF_LABELS: Record<string, { icon: IconName; key: string }> = {
  follow:         { icon: "user", key: "notif_followed_you" },
  follow_request: { icon: "user-plus", key: "notif_follow_request" },
  mention:        { icon: "comment", key: "notif_mentioned" },
  reblog:         { icon: "retweet", key: "notif_boosted" },
  favourite:      { icon: "heart", key: "notif_liked" },
  poll:           { icon: "bar-chart", key: "notif_poll" },
  update:         { icon: "pencil", key: "notif_edited" },
  direct:         { icon: "envelope", key: "notif_dm" },
  encrypted:      { icon: "lock", key: "notif_encrypted" },
  quote:          { icon: "quote-left", key: "notif_quoted" },
};

export default function NotificationsPage() {
  const [pendingRequests, setPendingRequests] = useState<Account[]>([]);
  const [me, setMe] = useState<Account | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { t } = useLocale();
  const limits = useLimits();

  const fetchPage = useCallback(async (maxId?: string) => {
    const base = `/api/v1/notifications?limit=${limits.pageSize}`;
    const url = maxId ? `${base}&max_id=${encodeURIComponent(maxId)}` : base;
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) return { items: [], hasMore: true };
    const items = await res.json() as Notification[];
    return { items, hasMore: items.length >= limits.pageSize };
  }, [limits.pageSize]);

  const { statuses: notifications, setStatuses: setNotifications, loading, loadingMore, hasMore, loadMore, catchUp } = useTimelineCache<Notification>("notifications", fetchPage, { refetchOnMount: true });

  async function fetchFollowRequests() {
    const res = await fetch(`/api/v1/follow_requests?limit=${limits.pageSize}`, { credentials: "include" });
    if (res.ok) setPendingRequests(await res.json() as Account[]);
  }

  async function fetchMe() {
    const res = await fetch("/api/v1/accounts/verify_credentials", { credentials: "include" });
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
    if (pendingAction) return;
    const actionKey = notificationId ?? accountId;
    setPendingAction(actionKey);
    const res = await fetch(`/api/v1/follow_requests/${encodeURIComponent(accountId)}/${action}`, {
      method: "POST",
      credentials: "include",
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
    await fetch("/api/v1/notifications/clear", {
      method: "POST",
      credentials: "include",
    });
  }

  useEffect(() => {
    Promise.resolve().then(() => void fetchFollowRequests());
    Promise.resolve().then(() => void fetchMe());
    void markAllRead();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real-time: prepend new notifications as they arrive via streaming.
  // Payload is currently "{}" so we refetch the latest notification instead.
  useTimelineStream("user:notification", (event) => {
    if (event !== "notification") return;
    // Fetch just the latest notification and prepend it if not already seen
    fetch("/api/v1/notifications?limit=1", { credentials: "include", cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json() as Notification[];
        if (data.length === 0) return;
        setNotifications((prev) => {
          if (prev.some((n) => n.id === data[0].id)) return prev;
          return [data[0], ...prev];
        });
      })
      .catch(() => {});
  }, {
    onReconnect: () => {
      // Catch up on notifications that arrived while the socket was down.
      void catchUp();
    },
  });

  // Infinite scroll
  useEffect(() => {
    if (!bottomRef.current || !hasMore) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) void loadMore(); },
      { rootMargin: "300px" }
    );
    obs.observe(bottomRef.current);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loadingMore, notifications]);

  return (
    <>
    <PageLayout sidebar={<Sidebar me={me} currentPath="/notifications" />}>

      {/* Main */}
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
                      <Icon name="user" size="1.5rem" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="flex items-baseline gap-2" style={{ marginBottom: "0.25rem" }}>
                        <Avatar avatar={account.avatar} name={account.display_name || account.username} size={28} />
                        <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                          <DisplayName name={account.display_name || account.username} emojis={account.emojis} />
                          {account.verified && <span title={t.verified_badge} style={{ marginLeft: "0.25rem", verticalAlign: "middle" }}><Icon name="check" color="var(--success)" size="0.8rem" /></span>}
                        </span>
                        <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                          {t.notif_follow_request}
                        </span>
                      </div>
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
                          className="btn btn-outline btn-sm"
                          disabled={pendingAction === account.id}
                          onClick={() => void handleFollowRequestAction(null, account.id, "reject")}
                        >
                          {t.notif_reject}
                        </button>
                      </div>
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
            <span style={{ fontSize: "3rem", marginBottom: "1rem" }}><Icon name="bell" size="3rem" /></span>
            <p style={{ fontWeight: 600 }}>{t.notif_empty}</p>
            <p style={{ fontSize: "0.875rem", marginTop: "0.5rem" }}>
              {t.notif_empty_sub}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {notifications.map((n) => {
              const meta = NOTIF_LABELS[n.type] ?? { icon: "bell" as IconName, key: "" };
              const metaText = meta.key ? (t[meta.key as keyof typeof t] ?? n.type) : n.type;
              const accountHref = getProfileHref(n.account);
              // Server-side filters: hide notifications whose status is filtered
              // with a "hide" action in the notifications context.
              const hiddenByFilter = (n.status?.filtered ?? []).some(
                (fr) => fr.filter.context?.includes("notifications") && fr.filter.filter_action === "hide"
              );
              if (hiddenByFilter) return null;
              return (
                <div
                  key={n.id}
                  className="flex gap-3"
                  style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}
                >
                  <div style={{ fontSize: "1.5rem", flexShrink: 0, width: 42, textAlign: "center", paddingTop: "0.1rem" }}>
                    <Icon name={meta.icon} size="1.5rem" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex items-baseline gap-2" style={{ marginBottom: "0.25rem" }}>
                      <Link href={accountHref} style={{ textDecoration: "none" }}>
                        <Avatar avatar={n.account.avatar} name={n.account.display_name || n.account.username} size={28} />
                      </Link>
                      <Link href={accountHref} style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)", textDecoration: "none" }}>
                        <DisplayName name={n.account.display_name || n.account.username} emojis={n.account.emojis} />
                        {n.account.verified && <span title={t.verified_badge} style={{ marginLeft: "0.25rem", verticalAlign: "middle" }}><Icon name="check" color="var(--success)" size="0.8rem" /></span>}
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
                        >
                          <RichText html={n.status.content} />
                        </div>
                      </Link>
                    )}
                    {n.type === "follow_request" && (
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
            <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
              {loadingMore ? t.loading : ""}
            </div>
          </div>
        )}
          </>
        )}
      </PageLayout>
      <BackToTop />
    </>
  );
}
