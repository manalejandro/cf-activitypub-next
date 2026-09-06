"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { StatusCard } from "@/components/StatusCard";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import type { Status, Me } from "@/components/StatusCard";
import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/Avatar";
import { Loading } from "@/components/Loading";

export default function ConversationDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [conv, setConv] = useState<{ id: string; accounts: { id: string; username: string; acct: string; display_name: string; avatar: string }[]; last_status: Status | null } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [messages, setMessages] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const token = getToken();
  const { t } = useLocale();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token || !params?.id) { router.push("/login"); return; }
    async function fetchMe() {
      if (!token) return;
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }
    async function fetchConversation() {
      if (!token || !params?.id) return;
      const rawId = decodeURIComponent(params.id);
      const res = await fetch(`/api/v1/conversations/${encodeURIComponent(rawId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { setLoading(false); return; }
      const data = await res.json() as { id: string; accounts: { id: string; username: string; acct: string; display_name: string; avatar: string }[]; last_status: Status | null };
      setConv(data);

      // Mark the conversation as read when opened.
      void fetch(`/api/v1/conversations/${encodeURIComponent(data.id)}/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});

      if (data.last_status) {
        // Load the full thread (ancestors + focal + descendants) so the
        // conversation shows every message, not just the latest one.
        try {
          const ctxRes = await fetch(`/api/v1/statuses/${encodeURIComponent(data.last_status.id)}/context`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (ctxRes.ok) {
            const ctx = await ctxRes.json() as { ancestors: Status[]; descendants: Status[] };
            setMessages([...(ctx.ancestors ?? []), data.last_status, ...(ctx.descendants ?? [])]);
            setLoading(false);
            return;
          }
        } catch { /* fall through to single message */ }
        setMessages([data.last_status]);
      }
      setLoading(false);
    }
    void fetchMe();
    void fetchConversation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !text.trim() || !conv?.accounts[0]) return;
    setSending(true);
    const res = await fetch("/api/v1/statuses", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        status: text,
        visibility: "direct",
        in_reply_to_id: conv.last_status?.id ?? undefined,
      }),
    });
    if (res.ok) {
      const newStatus = await res.json() as Status;
      setMessages((prev) => [...prev, newStatus]);
      setText("");
    }
    setSending(false);
  }

  const other = conv?.accounts[0];

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/messages" />}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "0.75rem 1rem", zIndex: 10, display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button className="btn btn-ghost btn-sm" aria-label={t.action_close} onClick={() => router.push("/messages")}><Icon name="arrow-left" /></button>
          <Avatar avatar={other?.avatar} name={other?.display_name || other?.username || "?"} size={36} />
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{other?.display_name || other?.username || "Unknown"}</div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>@{other?.acct}</div>
          </div>
        </div>

        <div className="flex-1" style={{ overflowY: "auto" }}>
          {loading ? (
            <Loading />
          ) : messages.length === 0 ? (
            <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
              <div style={{ fontWeight: 600 }}>{t.messages_empty}</div>
            </div>
          ) : (
            messages.map((s) => (
              <StatusCard
                key={s.id}
                status={s}
                me={me}
                onFav={() => {}}
                onReblog={() => {}}
                onReply={() => {}}
                onDelete={() => setMessages((prev) => prev.filter((m) => m.id !== s.id))}
                onEdit={() => {}}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={(e) => void handleSend(e)} style={{ padding: "0.75rem 1rem", borderTop: "1px solid var(--border)", display: "flex", gap: "0.5rem", background: "var(--bg)" }}>
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={t.messages_placeholder}
            aria-label={t.messages_placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={sending}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || sending}>
            {sending ? "…" : t.messages_send}
          </button>
        </form>
    </PageLayout>
  );
}
