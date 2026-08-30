"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";
import { MAX_COLLECTION_NAME_CHARS, MAX_COLLECTION_DESCRIPTION_CHARS } from "@/lib/constants";

interface Collection {
  id: string;
  name: string;
  description: string | null;
  item_count: number;
  discoverable: boolean;
  created_at: string;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function CollectionsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [discoverable, setDiscoverable] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDiscoverable, setEditDiscoverable] = useState(true);
  const token = getToken();
  const { t } = useLocale();

  useEffect(() => {
    async function fetchMe() {
      if (!token) return;
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }

    async function fetchCollections() {
      if (!token) return;
      setLoading(true);
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { setLoading(false); return; }
      const meData = await res.json() as Me;
      const collectionsRes = await fetch(`/api/v1/accounts/${encodeURIComponent(meData.id)}/collections`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (collectionsRes.ok) {
        const data = await collectionsRes.json() as { collections: Collection[] };
        setCollections(data.collections ?? []);
      }
      setLoading(false);
    }

    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchCollections();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !name.trim() || busy) return;
    setBusy(true);
    const res = await fetch("/api/v1/collections", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description: description.trim() || null, discoverable }),
    });
    if (res.ok) {
      const data = await res.json() as { collection: Collection };
      setCollections((prev) => [data.collection, ...prev]);
      setName("");
      setDescription("");
      setDiscoverable(true);
      setCreating(false);
    }
    setBusy(false);
  }

  async function handleSaveEdit() {
    if (!token || !editingId || !editName.trim() || busy) return;
    setBusy(true);
    const res = await fetch(`/api/v1/collections/${encodeURIComponent(editingId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName.trim(), description: editDescription.trim() || null, discoverable: editDiscoverable }),
    });
    if (res.ok) {
      const data = await res.json() as { collection: Collection };
      setCollections((prev) => prev.map((c) => c.id === data.collection.id ? data.collection : c));
    }
    setEditingId(null);
    setBusy(false);
  }

  async function handleDelete(collection: Collection) {
    if (!token || !confirm(t.collections_confirm_delete)) return;
    await fetch(`/api/v1/collections/${encodeURIComponent(collection.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setCollections((prev) => prev.filter((c) => c.id !== collection.id));
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/collections" />}>
      <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 className="text-lg font-bold">{t.collections_title}</h1>
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>{t.collections_create}</button>
      </div>

      {creating && (
        <form onSubmit={(e) => void handleCreate(e)} style={{ padding: "1rem", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            {t.collections_name}
            <input className="input" placeholder={t.collections_name_ph} aria-label={t.collections_name_ph} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={MAX_COLLECTION_NAME_CHARS} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
            {t.collections_description}
            <input className="input" placeholder={t.collections_description_ph} aria-label={t.collections_description_ph} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={MAX_COLLECTION_DESCRIPTION_CHARS} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", cursor: "pointer" }}>
            <input type="checkbox" checked={discoverable} onChange={(e) => setDiscoverable(e.target.checked)} />
            {t.collections_discoverable}
          </label>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim() || busy}><Icon name="check" color="#fff" /></button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>{t.profile_cancel}</button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
      ) : collections.length === 0 ? (
        <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
          <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}><Icon name="users" size="2rem" /></div>
          <div style={{ fontWeight: 600 }}>{t.collections_empty}</div>
          <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{t.collections_empty_sub}</div>
        </div>
      ) : (
        collections.map((collection) => (
          <div key={collection.id} style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
            {editingId === collection.id ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
                  {t.collections_name}
                  <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} aria-label={t.collections_name_ph} autoFocus maxLength={MAX_COLLECTION_NAME_CHARS} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
                  {t.collections_description}
                  <input className="input" value={editDescription} onChange={(e) => setEditDescription(e.target.value)} aria-label={t.collections_description_ph} maxLength={MAX_COLLECTION_DESCRIPTION_CHARS} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", cursor: "pointer" }}>
                  <input type="checkbox" checked={editDiscoverable} onChange={(e) => setEditDiscoverable(e.target.checked)} />
                  {t.collections_discoverable}
                </label>
                <div className="flex gap-2">
                  <button className="btn btn-primary btn-sm" aria-label={t.collections_save} onClick={() => void handleSaveEdit()} disabled={!editName.trim() || busy}><Icon name="check" color="#fff" /></button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>{t.profile_cancel}</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Link href={`/collections/${encodeURIComponent(collection.id)}`} style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem", color: "var(--text)" }}>{collection.name}</div>
                  {collection.description && (
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{collection.description}</div>
                  )}
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                    {t.collections_item_count.replace("{count}", String(collection.item_count))}
                  </div>
                </Link>
                <button className="btn btn-ghost btn-sm" aria-label={t.collections_edit} onClick={() => { setEditingId(collection.id); setEditName(collection.name); setEditDescription(collection.description ?? ""); setEditDiscoverable(collection.discoverable); }}>
                  <Icon name="pencil" />
                </button>
                <button className="btn btn-ghost btn-sm" aria-label={t.collections_delete} style={{ color: "var(--danger)" }} onClick={() => void handleDelete(collection)}>
                  <Icon name="trash" color="var(--danger)" />
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </PageLayout>
  );
}
