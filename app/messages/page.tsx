"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";
import type { Status, Me } from "@/components/StatusCard";

interface Conversation {
  id: string;
  unread: boolean;
  accounts: { id: string; username: string; acct: string; display_name: string; avatar: string }[];
  last_status: Status | null;
}

export default function MessagesPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchConversations();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchConversations() {
    if (!token) return;
    const res = await fetch("/api/v1/conversations", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setConversations(await res.json() as Conversation[]);
    setLoading(false);
  }

  async function handleMarkRead(id: string) {
    if (!token) return;
    await fetch(`/api/v1/conversations/${encodeURIComponent(id)}/read`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setConversations((prev) => prev.map((c) => c.id === id ? { ...c, unread: false } : c));
  }

  async function handleDelete(id: string) {
    if (!token) return;
    await fetch(`/api/v1/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setConversations((prev) => prev.filter((c) => c.id !== id));
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/messages" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
          <h1 className="text-lg font-bold">{t.messages_title}</h1>
        </div>
        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : conversations.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>💬</div>
            <div style={{ fontWeight: 600 }}>{t.messages_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.messages_empty_sub}</div>
          </div>
        ) : (
          conversations.map((conv) => {
            const other = conv.accounts[0];
            return (
              <div key={conv.id} style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", background: conv.unread ? "var(--accent-bg)" : undefined }}>
                <Link href={`/messages/${encodeURIComponent(conv.id)}`} style={{ textDecoration: "none", color: "inherit", display: "flex", gap: "0.75rem" }}>
                  <div className="avatar" style={{ width: 44, height: 44, flexShrink: 0, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", fontWeight: 700, color: "var(--accent)", fontSize: "1.1rem" }}>
                    {other ? (other.display_name?.[0] ?? other.username?.[0] ?? "?").toUpperCase() : "?"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span style={{ fontWeight: conv.unread ? 700 : 600, fontSize: "0.9rem", color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {other?.display_name || other?.username || "Unknown"}
                      </span>
                      {conv.unread && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }} />}
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "0.15rem" }}>
                      {conv.last_status?.content ? (
                        <span dangerouslySetInnerHTML={{ __html: conv.last_status.content.replace(/<[^>]+>/g, "").slice(0, 120) }} />
                      ) : "(sin mensajes)"}
                    </div>
                  </div>
                </Link>
                <div className="flex gap-2 mt-1" style={{ marginLeft: "3.5rem" }}>
                  {conv.unread && (
                    <button className="btn btn-ghost btn-xs" onClick={() => void handleMarkRead(conv.id)}>
                      {t.messages_mark_read}
                    </button>
                  )}
                  <button className="btn btn-ghost btn-xs" style={{ color: "var(--danger)" }} onClick={() => void handleDelete(conv.id)}>
                    {t.messages_delete}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </main>
    </div>
  );
}
