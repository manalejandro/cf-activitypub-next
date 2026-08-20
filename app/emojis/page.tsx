"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";

interface Emoji {
  id: string;
  shortcode: string;
  url: string;
  staticUrl: string;
  category: string | null;
  visibleInPicker: boolean;
  domain: string | null;
  disabled: boolean;
  createdAt: string;
}

export default function EmojisPage() {
  const { t } = useLocale();
  const [emojis, setEmojis] = useState<Emoji[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [shortcode, setShortcode] = useState("");
  const [category, setCategory] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [isStaff, setIsStaff] = useState(false);
  const token = getToken();

  useEffect(() => {
    if (!token) { window.location.href = "/login"; return; }
    fetch("/api/v1/accounts/verify_credentials", { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.ok ? res.json() as Promise<{ role?: string; roles?: { name?: string }[] }> : null)
      .then((me) => {
        const role = me?.role ?? me?.roles?.[0]?.name?.toLowerCase() ?? "";
        if (role !== "admin" && role !== "moderator") {
          window.location.href = "/home";
          return;
        }
        setIsStaff(true);
      })
      .catch(() => { window.location.href = "/home"; });
  }, [token]);

  const loadEmojis = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/emojis", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setEmojis(await res.json() as Emoji[]);
    } catch { /* ignore */ }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    if (isStaff) Promise.resolve().then(() => void loadEmojis());
  }, [isStaff, loadEmojis]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !shortcode.trim() || !token) return;
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("shortcode", shortcode.trim());
      if (category.trim()) form.append("category", category.trim());
      const res = await fetch("/api/admin/emojis", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      if (res.ok) {
        setMessage({ type: "success", text: t.emojis_uploaded.replace("{shortcode}", shortcode.trim()) });
        setShortcode("");
        setCategory("");
        setFile(null);
        await loadEmojis();
      } else {
        const err = await res.json() as { error?: string };
        setMessage({ type: "error", text: err.error ?? t.emojis_upload_error });
      }
    } catch {
      setMessage({ type: "error", text: t.network_error });
    }
    setUploading(false);
  }

  async function toggleDisable(emoji: Emoji) {
    if (!token) return;
    await fetch(`/api/admin/emojis/${emoji.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: !emoji.disabled }),
    });
    await loadEmojis();
  }

  async function handleDelete(emoji: Emoji) {
    if (!token || !confirm(t.emojis_delete_confirm.replace("{shortcode}", emoji.shortcode))) return;
    await fetch(`/api/admin/emojis/${emoji.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    await loadEmojis();
  }

  const localEmojis = emojis.filter((e) => !e.domain);
  const federatedEmojis = emojis.filter((e) => e.domain);

  if (!isStaff) {
    return (
      <PageLayout sidebar={<Sidebar currentPath="/emojis" />}>
        <div style={{ color: "var(--text-muted)", padding: "1rem" }}>{t.loading}</div>
      </PageLayout>
    );
  }

  return (
    <PageLayout sidebar={<Sidebar currentPath="/emojis" />}>
      <div style={{ padding: "1rem" }}>
        <h1 style={{ fontWeight: 700, fontSize: "1.25rem", marginBottom: "1rem" }}>{t.emojis_title}</h1>

        {/* Upload form */}
        <form onSubmit={handleUpload} style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "2rem", padding: "1rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
          <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{t.emojis_upload_new}</div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder={t.emojis_shortcode_ph}
              value={shortcode}
              onChange={(e) => setShortcode(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
              className="input"
              style={{ flex: 1, minWidth: 150, fontSize: "0.9rem" }}
              maxLength={32}
            />
            <input
              type="text"
              placeholder={t.emojis_category_ph}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="input"
              style={{ flex: 1, minWidth: 120, fontSize: "0.9rem" }}
              maxLength={32}
            />
            <input
              type="file"
              accept="image/png,image/gif,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: "0.85rem", flex: 1, minWidth: 140 }}
            />
          </div>
          {message && (
            <div style={{ fontSize: "0.85rem", color: message.type === "success" ? "var(--accent)" : "var(--danger)" }}>
              {message.text}
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-sm" disabled={uploading || !file || !shortcode.trim()} style={{ alignSelf: "flex-start" }}>
            {uploading ? t.emojis_uploading : t.emojis_upload}
          </button>
        </form>

        {/* Local emoji list */}
        <div style={{ fontWeight: 600, fontSize: "1rem", marginBottom: "0.75rem" }}>
          {t.emojis_local_count.replace("{count}", String(localEmojis.length))}
        </div>
        {loading ? (
          <div style={{ color: "var(--text-muted)", padding: "1rem" }}>{t.loading}</div>
        ) : localEmojis.length === 0 ? (
          <div style={{ color: "var(--text-muted)", padding: "0.5rem 0", fontSize: "0.9rem" }}>{t.emojis_empty_local}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "1.5rem" }}>
            {localEmojis.map((emoji) => (
              <div key={emoji.id} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--border)", opacity: emoji.disabled ? 0.5 : 1 }}>
                <Image src={emoji.url} alt={`:${emoji.shortcode}:`} width={28} height={28} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>: {emoji.shortcode} :</div>
                  {emoji.category && <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{emoji.category}</div>}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "0.78rem", color: emoji.disabled ? "var(--accent)" : "var(--text-muted)" }}
                  onClick={() => toggleDisable(emoji)}
                >
                  {emoji.disabled ? t.emojis_enable : t.emojis_disable}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "0.78rem", color: "var(--danger)" }}
                  onClick={() => handleDelete(emoji)}
                >
                  {t.emojis_delete}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Federated emoji list */}
        {federatedEmojis.length > 0 && (
          <>
            <div style={{ fontWeight: 600, fontSize: "1rem", marginBottom: "0.75rem", marginTop: "1rem" }}>
              {t.emojis_federated_count.replace("{count}", String(federatedEmojis.length))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {federatedEmojis.map((emoji) => (
                <div key={emoji.id} style={{ display: "flex", alignItems: "center", gap: "0.4rem", padding: "0.3rem 0.5rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", fontSize: "0.82rem" }}>
                  <Image src={emoji.url} alt={`:${emoji.shortcode}:`} width={18} height={18} />
                  <span>{emoji.shortcode}</span>
                  <span style={{ color: "var(--text-muted)", fontSize: "0.72rem" }}>{emoji.domain}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </PageLayout>
  );
}
