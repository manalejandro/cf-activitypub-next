"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { getToken } from "@/lib/client-api";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { Loading } from "@/components/Loading";

interface Filter {
  id: string;
  phrase: string;
  context: string[];
  whole_word: boolean;
  expires_at: string | null;
  irreversible: boolean;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

const CONTEXT_OPTIONS = ["home", "notifications", "public", "thread", "account"] as const;

function formatExpires(expiresAt: string | null, t: Translations): string {
  if (!expiresAt) return t.filters_never;
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return t.filters_expired;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
function expiresOptions(t: Translations): { label: string; value: number }[] {
  return [
    { label: t.filters_never, value: 0 },
    { label: t.filters_30m, value: 1800 },
    { label: t.filters_1h, value: 3600 },
    { label: t.filters_6h, value: 21600 },
    { label: t.filters_12h, value: 43200 },
    { label: t.filters_1d, value: 86400 },
    { label: t.filters_2d, value: 172800 },
    { label: t.filters_7d, value: 604800 },
  ];
}

export default function FiltersPage() {
  const router = useRouter();
  const { t } = useLocale();
  const [me, setMe] = useState<Me | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [context, setContext] = useState<string[]>(["home", "notifications"]);
  const [irreversible, setIrreversible] = useState(false);
  const [expiresIn, setExpiresIn] = useState(0);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const token = getToken();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }

    async function fetchMe() {
      if (!token) return;
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }

    async function fetchFilters() {
      if (!token) return;
      setLoading(true);
      const res = await fetch("/api/v1/filters", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setFilters(await res.json() as Filter[]);
      setLoading(false);
    }

    void fetchMe();
    void fetchFilters();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleContext(val: string) {
    setContext((prev) =>
      prev.includes(val) ? prev.filter((c) => c !== val) : [...prev, val]
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !phrase.trim() || context.length === 0) return;
    setCreating(true);
    const body: Record<string, unknown> = {
      phrase: phrase.trim(),
      context,
      irreversible,
      whole_word: true,
    };
    if (expiresIn > 0) body.expires_in = expiresIn;
    const res = await fetch("/api/v1/filters", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const filter = await res.json() as Filter;
      setFilters((prev) => [...prev, filter]);
      setPhrase("");
      setContext(["home", "notifications"]);
      setIrreversible(false);
      setExpiresIn(0);
      setShowForm(false);
    }
    setCreating(false);
  }

  async function handleDelete(filter: Filter) {
    if (!token) return;
    setDeletingId(filter.id);
    await fetch(`/api/v1/filters/${encodeURIComponent(filter.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setFilters((prev) => prev.filter((f) => f.id !== filter.id));
    setDeletingId(null);
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/filters" />}>
        <div
          className="sticky top-0"
          style={{
            background: "var(--bg)",
            borderBottom: "1px solid var(--border)",
            padding: "1rem",
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h1 className="text-lg font-bold">{t.filters_title}</h1>
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? t.profile_cancel : t.filters_new}
          </button>
        </div>

        {showForm && (
          <form
            onSubmit={(e) => void handleCreate(e)}
            style={{
              padding: "1rem",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            <input
              className="input"
              placeholder={t.filters_phrase_ph}
              aria-label={t.filters_phrase_ph}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoFocus
            />

            <div>
              <div style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.375rem", color: "var(--text-muted)" }}>
                {t.filters_context}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                {CONTEXT_OPTIONS.map((c) => (
                  <label
                    key={c}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.3rem",
                      fontSize: "0.85rem",
                      cursor: "pointer",
                      color: "var(--text)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={context.includes(c)}
                      onChange={() => toggleContext(c)}
                      style={{ accentColor: "var(--accent)" }}
                    />
                    {c}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.375rem", color: "var(--text-muted)" }}>
                {t.filters_action}
              </div>
              <select
                className="input"
                value={irreversible ? "hide" : "warn"}
                onChange={(e) => setIrreversible(e.target.value === "hide")}
              >
                <option value="warn">{t.filters_warn}</option>
                <option value="hide">{t.filters_hide}</option>
              </select>
            </div>

            <div>
              <div style={{ fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.375rem", color: "var(--text-muted)" }}>
                {t.filters_expires_in}
              </div>
              <select
                className="input"
                value={expiresIn}
                onChange={(e) => setExpiresIn(Number(e.target.value))}
              >
                {expiresOptions(t).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={creating || !phrase.trim() || context.length === 0}
              >
                {creating ? "…" : t.filters_create}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowForm(false)}
              >
                {t.profile_cancel}
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <Loading />
        ) : filters.length === 0 ? (
          <div className="p-4" style={{ color: "var(--text-muted)", textAlign: "center", padding: "3rem 1rem" }}>
            <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}><Icon name="folder-o" size="2rem" /></div>
            <div style={{ fontWeight: 600 }}>{t.filters_empty}</div>
            <div style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
              {t.filters_empty_sub}
            </div>
          </div>
        ) : (
          filters.map((filter) => (
            <div
              key={filter.id}
              style={{
                padding: "0.875rem 1rem",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)", wordBreak: "break-word" }}>
                    {filter.phrase}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem", marginTop: "0.375rem" }}>
                    {filter.context.map((c) => (
                      <span
                        key={c}
                        style={{
                          fontSize: "0.72rem",
                          padding: "0.125rem 0.375rem",
                          borderRadius: "var(--radius)",
                          background: "var(--accent-bg)",
                          color: "var(--accent)",
                          fontWeight: 500,
                        }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.375rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    <span>
                      {t.filters_action_label}<strong>{filter.irreversible ? t.filters_hide : t.filters_warn}</strong>
                    </span>
                    <span>
                      {t.filters_expires_label}<strong>{formatExpires(filter.expires_at, t)}</strong>
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{
                    background: "var(--danger, #e11d48)",
                    color: "#fff",
                    border: "none",
                    borderRadius: "var(--radius)",
                    padding: "0.35rem 0.75rem",
                    cursor: "pointer",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                  disabled={deletingId === filter.id}
                  onClick={() => void handleDelete(filter)}
                >
                  {deletingId === filter.id ? "…" : t.action_delete}
                </button>
              </div>
            </div>
          ))
        )}
    </PageLayout>
  );
}
