"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";

interface List {
  id: string;
  title: string;
  replies_policy: string;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

const repliesPolicies = [
  { value: "followed", labelKey: "lists_replies_followed" as const },
  { value: "none", labelKey: "lists_replies_none" as const },
  { value: "list", labelKey: "lists_replies_list" as const },
];

export default function ListsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPolicy, setNewPolicy] = useState("followed");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editPolicy, setEditPolicy] = useState("followed");
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchLists();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchLists() {
    if (!token) return;
    setLoading(true);
    const res = await fetch("/api/v1/lists", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setLists(await res.json() as List[]);
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newTitle.trim()) return;
    const res = await fetch("/api/v1/lists", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle.trim(), replies_policy: newPolicy }),
    });
    if (res.ok) {
      const list = await res.json() as List;
      setLists((prev) => [...prev, list]);
      setNewTitle("");
      setCreating(false);
    }
  }

  async function handleSaveEdit(list: List) {
    if (!token || !editTitle.trim()) return;
    const res = await fetch(`/api/v1/lists/${encodeURIComponent(list.id)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: editTitle.trim(), replies_policy: editPolicy }),
    });
    if (res.ok) {
      const updated = await res.json() as List;
      setLists((prev) => prev.map((l) => l.id === updated.id ? updated : l));
    }
    setEditingId(null);
  }

  async function handleDelete(list: List) {
    if (!token || !confirm(t.lists_confirm_delete)) return;
    await fetch(`/api/v1/lists/${encodeURIComponent(list.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setLists((prev) => prev.filter((l) => l.id !== list.id));
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/lists" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 className="text-lg font-bold">{t.lists_title}</h1>
          <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>{t.lists_create}</button>
        </div>

        {creating && (
          <form onSubmit={(e) => void handleCreate(e)} style={{ padding: "1rem", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <input className="input" placeholder={t.lists_name_ph} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} autoFocus />
            <select className="input" value={newPolicy} onChange={(e) => setNewPolicy(e.target.value)}>
              {repliesPolicies.map((p) => (
                <option key={p.value} value={p.value}>{t[p.labelKey]}</option>
              ))}
            </select>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary btn-sm" disabled={!newTitle.trim()}>✓</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>{t.profile_cancel}</button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        ) : lists.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>📋</div>
            <div style={{ fontWeight: 600 }}>{t.lists_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.lists_empty_sub}</div>
          </div>
        ) : (
          lists.map((list) => (
            <div key={list.id} style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
              {editingId === list.id ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <input className="input" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} autoFocus />
                  <select className="input" value={editPolicy} onChange={(e) => setEditPolicy(e.target.value)}>
                    {repliesPolicies.map((p) => (
                      <option key={p.value} value={p.value}>{t[p.labelKey]}</option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <button className="btn btn-primary btn-sm" onClick={() => void handleSaveEdit(list)} disabled={!editTitle.trim()}>✓</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>{t.profile_cancel}</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <Link href={`/lists/${encodeURIComponent(list.id)}`} style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
                    <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)" }}>{list.title}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{t.lists_manage_accounts}</div>
                  </Link>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setEditingId(list.id); setEditTitle(list.title); setEditPolicy(list.replies_policy); }}>
                    ✏️
                  </button>
                  <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={() => void handleDelete(list)}>
                    🗑️
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </main>
    </div>
  );
}
