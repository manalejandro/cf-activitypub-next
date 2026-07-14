"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { StatusCard } from "@/components/StatusCard";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import type { Status, Me } from "@/components/StatusCard";

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
    void fetchMe();
    void fetchConversation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchConversation() {
    if (!token || !params?.id) return;
    const res = await fetch(`/api/v1/conversations/${encodeURIComponent(params.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as { id: string; accounts: { id: string; username: string; acct: string; display_name: string; avatar: string }[]; last_status: Status | null };
      setConv(data);
      if (data.last_status) setMessages([data.last_status]);
    }
    setLoading(false);
  }

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
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/messages" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "0.75rem 1rem", zIndex: 10, display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => router.push("/messages")}>←</button>
          <div className="avatar" style={{ width: 36, height: 36, flexShrink: 0, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", fontWeight: 700, color: "var(--accent)", fontSize: "0.9rem" }}>
            {other ? (other.display_name?.[0] ?? other.username?.[0] ?? "?").toUpperCase() : "?"}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{other?.display_name || other?.username || "Unknown"}</div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>@{other?.acct}</div>
          </div>
        </div>

        <div className="flex-1" style={{ overflowY: "auto" }}>
          {loading ? (
            <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
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
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={sending}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || sending}>
            {sending ? "…" : t.messages_send}
          </button>
        </form>
      </main>
    </div>
  );
}
