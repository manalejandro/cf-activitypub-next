"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface CollectionAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

interface CollectionItem {
  id: string;
  account_id: string;
  state: string;
  created_at: string;
}

interface Collection {
  id: string;
  account_id: string;
  name: string;
  description: string | null;
  item_count: number;
  items: CollectionItem[];
}

export default function CollectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [collection, setCollection] = useState<Collection | null>(null);
  const [accounts, setAccounts] = useState<CollectionAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [addValue, setAddValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const token = getToken();
  const { t } = useLocale();

  async function fetchCollection(collectionId: string) {
    if (!token) return;
    const res = await fetch(`/api/v1/collections/${encodeURIComponent(collectionId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json() as { accounts: CollectionAccount[]; collection: Collection };
      setCollection(data.collection);
      setAccounts(data.accounts ?? []);
    }
    setLoading(false);
  }

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
    void (async () => {
      const { id } = await params;
      await fetchCollection(id);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const acct = addValue.trim();
    if (!token || !collection || !acct || adding) return;
    setAdding(true);
    setMessage(null);
    try {
      const lookupRes = await fetch(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!lookupRes.ok) {
        setMessage({ ok: false, text: t.collections_add_failed });
        setAdding(false);
        return;
      }
      const account = await lookupRes.json() as CollectionAccount;
      const res = await fetch(`/api/v1/collections/${encodeURIComponent(collection.id)}/items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: account.id }),
      });
      if (res.ok) {
        setMessage({ ok: true, text: t.collections_added });
        setAddValue("");
        await fetchCollection(collection.id);
      } else {
        setMessage({ ok: false, text: t.collections_add_failed });
      }
    } catch {
      setMessage({ ok: false, text: t.collections_add_failed });
    }
    setAdding(false);
  }

  async function handleRemove(account: CollectionAccount) {
    if (!token || !collection) return;
    const item = collection.items.find((i) => i.account_id === account.id);
    if (!item) return;
    setRemovingId(account.id);
    const res = await fetch(`/api/v1/collections/${encodeURIComponent(collection.id)}/items/${encodeURIComponent(item.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setCollection((prev) => prev ? { ...prev, items: prev.items.filter((i) => i.id !== item.id), item_count: Math.max(0, prev.item_count - 1) } : prev);
      setAccounts((prev) => prev.filter((a) => a.id !== account.id));
    }
    setRemovingId(null);
  }

  const members = collection ? accounts.filter((a) => a.id !== collection.account_id) : [];
  const isOwner = collection && me ? collection.account_id === me.id : false;

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/collections" />}>
      <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Link href="/collections" aria-label={t.collections_title} className="btn btn-ghost btn-sm" style={{ padding: "0.35rem 0.5rem" }}>
            <Icon name="arrow-left" />
          </Link>
          <h1 className="text-lg font-bold" style={{ margin: 0 }}>{collection?.name ?? ""}</h1>
        </div>
        {collection?.description && (
          <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", margin: "0.5rem 0 0", paddingLeft: "2.25rem" }}>{collection.description}</p>
        )}
      </div>

      {loading ? (
        <div className="p-4" style={{ color: "var(--text-muted)" }}>{t.loading}</div>
      ) : !collection ? (
        <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
          {t.collections_empty}
        </div>
      ) : (
        <>
          {isOwner && (
            <form onSubmit={(e) => void handleAdd(e)} style={{ padding: "1rem", borderBottom: "1px solid var(--border)", display: "flex", gap: "0.5rem" }}>
              <input
                className="input"
                placeholder={t.collections_search_ph}
                aria-label={t.collections_search_ph}
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={!addValue.trim() || adding}>
                {adding ? "…" : t.collections_add_account}
              </button>
            </form>
          )}

          {message && (
            <div style={{ padding: "0.75rem 1rem", fontSize: "0.875rem", color: message.ok ? "var(--success)" : "var(--danger)", background: message.ok ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)" }}>
              {message.text}
            </div>
          )}

          <div style={{ padding: "0.75rem 1rem", fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)" }}>
            {t.collections_members}
          </div>

          {members.length === 0 ? (
            <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "2rem 1rem" }}>
              {t.collections_no_members}
            </div>
          ) : (
            members.map((account) => {
              const isRemote = account.acct.includes("@");
              const profileHref = isRemote
                ? `/users/remote?url=${encodeURIComponent(account.id)}`
                : `/users/${account.username}`;
              return (
                <div key={account.id} style={{ display: "flex", alignItems: "center", gap: "0.875rem", padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}>
                  <Link href={profileHref} style={{ flexShrink: 0 }}>
                    {account.avatar ? (
                      <Image src={account.avatar} alt="" width={40} height={40} style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover" }} />
                    ) : (
                      <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, color: "var(--accent)" }}>
                        {(account.display_name?.[0] ?? account.username?.[0] ?? "?").toUpperCase()}
                      </div>
                    )}
                  </Link>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link href={profileHref} style={{ fontWeight: 600, fontSize: "0.92rem", color: "var(--text)", textDecoration: "none" }}>
                      {account.display_name || account.username}
                    </Link>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>@{account.acct}</div>
                  </div>
                  {isOwner && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ background: "var(--danger, #e11d48)", color: "#fff", border: "none", borderRadius: "var(--radius)", padding: "0.3rem 0.8rem", cursor: "pointer", fontWeight: 600 }}
                      disabled={removingId === account.id}
                      onClick={() => void handleRemove(account)}
                      aria-label={t.collections_remove}
                    >
                      {removingId === account.id ? "…" : t.collections_remove}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </>
      )}
    </PageLayout>
  );
}
