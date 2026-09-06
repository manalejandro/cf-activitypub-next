"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { StatusCard, type Status } from "@/components/StatusCard";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { purgeStatusFromCache } from "@/lib/streaming/timeline-cache";
import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/Avatar";
import { useLimits } from "@/lib/limits-client";
import { Loading } from "@/components/Loading";

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
  const listId = params?.id ? decodeURIComponent(params.id) : "";
  const [me, setMe] = useState<Me | null>(null);
  const [list, setList] = useState<List | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [addAcct, setAddAcct] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("members");
  const token = getToken();
  const { t } = useLocale();
  const limits = useLimits();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const fetchPage = useCallback(async (maxId?: string) => {
    if (!token || !listId) return { items: [], hasMore: false };
    const base = `/api/v1/timelines/list?list_id=${encodeURIComponent(listId)}&limit=${limits.defaultTimelinePage}`;
    const url = maxId ? `${base}&max_id=${encodeURIComponent(maxId)}` : base;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { items: [], hasMore: true };
    const items = await res.json() as Status[];
    return { items, hasMore: items.length >= limits.defaultTimelinePage };
  }, [token, listId, limits.defaultTimelinePage]);

  const { statuses, setStatuses, loading: timelineLoading, loadingMore, hasMore, loadMore } = useTimelineCache(`list:${listId}`, fetchPage);

  // Live updates on list feeds: new statuses, deletions and counter/content
  // refreshes (edits, favs, reblogs, replies).
  useTimelineStream(`list:${listId}`, (event, payload) => {
    if (event === "update") {
      try {
        const status = JSON.parse(payload) as Status;
        setStatuses((prev) => {
          if (prev.some((s) => s.id === status.id)) return prev;
          return [status, ...prev];
        });
      } catch { /* ignore */ }
    } else if (event === "delete") {
      const deletedId = payload.replace(/^"|"$/g, "");
      purgeStatusFromCache(deletedId);
      setStatuses((prev) => prev.filter((s) => s.id !== deletedId));
    } else if (event === "status.update") {
      try {
        const updated = JSON.parse(payload) as Status;
        setStatuses((prev) => prev.map((s) => s.id === updated.id ? { ...s, ...updated } : s));
      } catch { /* ignore */ }
    }
  });

  useEffect(() => {
    if (!token || !params?.id) { router.push("/login"); return; }
    void fetchMe();
    void fetchList();
    void fetchAccounts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  // Infinite scroll sentinel for the timeline tab
  useEffect(() => {
    if (!bottomRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void loadMore();
      },
      { threshold: 0.1 }
    );
    observer.observe(bottomRef.current);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses, loadingMore, hasMore]);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchList() {
    if (!token || !params?.id) return;
    const res = await fetch(`/api/v1/lists/${encodeURIComponent(listId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setList(await res.json() as List);
  }

  async function fetchAccounts() {
    if (!token || !params?.id) return;
    const res = await fetch(`/api/v1/lists/${encodeURIComponent(listId)}/accounts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setAccounts(await res.json() as Account[]);
    setLoading(false);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !addAcct.trim() || !params?.id) return;
    setAdding(true);
    const res = await fetch(`/api/v1/lists/${encodeURIComponent(listId)}/accounts`, {
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
    await fetch(`/api/v1/lists/${encodeURIComponent(listId)}/accounts`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ account_ids: [account.id] }),
    });
    setAccounts((prev) => prev.filter((a) => a.id !== account.id));
    setRemovingId(null);
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/lists" />}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "0.75rem 1rem", zIndex: 10, display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button className="btn btn-ghost btn-sm" aria-label={t.action_close} onClick={() => router.push("/lists")}><Icon name="arrow-left" /></button>
          <h1 className="text-lg font-bold">{list?.title || t.lists_title}</h1>
        </div>

        <div className="flex" role="tablist" style={{ borderBottom: "1px solid var(--border)" }}>
          {(["members", "timeline"] as ActiveTab[]).map((tab) => (
            <button
              key={tab}
              className="btn btn-ghost"
              role="tab"
              aria-selected={activeTab === tab}
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
              <button type="submit" className="btn btn-primary btn-sm" aria-label={t.lists_add_account} disabled={!addAcct.trim() || adding}>
                {adding ? "…" : "+"}
              </button>
            </form>

            {loading ? (
              <Loading />
            ) : accounts.length === 0 ? (
              <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
                <div style={{ fontWeight: 600 }}>{t.lists_no_accounts}</div>
              </div>
            ) : (
              accounts.map((account) => (
                <div key={account.id} className="flex items-center gap-3" style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
                  <Link href={`/users/${account.acct.includes("@") ? "remote?url=" + encodeURIComponent(account.id) : account.username}`} style={{ display: "flex", alignItems: "center", gap: "0.75rem", flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
                    <Avatar avatar={account.avatar} name={account.display_name || account.username} size={36} />
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
          timelineLoading ? (
            <Loading />
          ) : statuses.length === 0 ? (
            <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--text-muted)" }}>
              <div style={{ fontSize: "2rem", marginBottom: "0.75rem" }}><Icon name="inbox" size="2rem" /></div>
              <div>{t.timeline_empty}</div>
            </div>
          ) : (
            <>
              {statuses.map((s) => (
                <div key={s.id} data-status-id={s.id}>
                  <StatusCard
                  filterContext="home"
                  status={s}
                    onFav={() => {}}
                    onReblog={() => {}}
                    onReply={() => {}}
                    onQuote={(status) => router.push(`/statuses/${encodeURIComponent(status.id)}?quote=1`)}
                    me={me}
                  />
                </div>
              ))}
              <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                {loadingMore && <Loading compact />}
              </div>
            </>
          )
        )}
    </PageLayout>
  );
}
