"use client";

import { useState, useEffect, useCallback } from "react";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { SettingsHeader } from "@/components/SettingsHeader";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";

type FilterAction = "warn" | "hide" | "blur";
type FilterContext = "home" | "notifications" | "public" | "thread" | "account";

interface FilterKeyword {
  id?: string;
  keyword: string;
  whole_word: boolean;
}

interface Filter {
  id: string;
  title: string;
  context: FilterContext[];
  expires_at: string | null;
  filter_action: FilterAction;
  keywords: FilterKeyword[];
  statuses: { id: string; status_id: string }[];
}

const CONTEXTS: FilterContext[] = ["home", "notifications", "public", "thread", "account"];
const ACTIONS: FilterAction[] = ["warn", "hide", "blur"];
const EXPIRIES: { seconds: number | null; key: string }[] = [
  { seconds: null, key: "filter_expiry_never" },
  { seconds: 1800, key: "filter_expiry_30m" },
  { seconds: 3600, key: "filter_expiry_1h" },
  { seconds: 21600, key: "filter_expiry_6h" },
  { seconds: 43200, key: "filter_expiry_12h" },
  { seconds: 86400, key: "filter_expiry_1d" },
  { seconds: 604800, key: "filter_expiry_1w" },
];

export default function FiltersSettingsPage() {
  const token = getToken();
  const { t } = useLocale();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Filter | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fetchFilters = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/v2/filters", { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setFilters(await res.json() as Filter[]);
    setLoading(false);
  }, [token]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchFilters());
  }, [fetchFilters]);

  // Refresh the expiry-clock so "expired" badges stay current.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  async function handleDelete(f: Filter) {
    if (!token) return;
    if (!confirm(t.filter_delete_confirm)) return;
    setDeletingId(f.id);
    const res = await fetch(`/api/v2/filters/${encodeURIComponent(f.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setFilters((prev) => prev.filter((x) => x.id !== f.id));
      window.dispatchEvent(new CustomEvent("cf-ap:filters-changed"));
    }
    setDeletingId(null);
  }

  const contextLabel = (c: FilterContext): string => {
    const map: Record<FilterContext, string> = {
      home: t.filter_context_home,
      notifications: t.filter_context_notifications,
      public: t.filter_context_public,
      thread: t.filter_context_thread,
      account: t.filter_context_account,
    };
    return map[c];
  };

  const actionLabel = (a: FilterAction): string => {
    const map: Record<FilterAction, string> = {
      warn: t.filter_action_warn,
      hide: t.filter_action_hide,
      blur: t.filter_action_blur,
    };
    return map[a];
  };

  const actionColor = (a: FilterAction): string =>
    a === "hide" ? "var(--danger)" : a === "blur" ? "var(--warning)" : "var(--text-muted)";

  const contextIcon = (c: FilterContext): string =>
    c === "home" ? "home" : c === "notifications" ? "bell" : c === "public" ? "globe" : c === "thread" ? "comments" : "user";

  const actionIcon = (a: FilterAction): string =>
    a === "hide" ? "ban" : a === "blur" ? "image" : "eye-slash";

  return (
    <PageLayout sidebar={<Sidebar currentPath="/settings/filters" />}>
      <SettingsHeader />

      {/* Header row: intro + create */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", padding: "1rem", borderBottom: "1px solid var(--border)" }}>
        <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)", margin: 0 }}>{t.filter_intro}</p>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          style={{ flexShrink: 0 }}
          onClick={() => {
            setError(null);
            setIsNew(true);
            setEditing({ id: "", title: "", context: ["home"], filter_action: "warn", expires_at: null, keywords: [], statuses: [] });
          }}
        >
          <Icon name="plus" color="#fff" /> {t.filter_create}
        </button>
      </div>

      {loading ? (
        <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
      ) : filters.length === 0 ? (
        <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>{t.filter_empty}</div>
      ) : (
        filters.map((f) => (
          <div key={f.id} style={{ display: "flex", alignItems: "flex-start", gap: "0.875rem", padding: "0.875rem 1rem", borderBottom: "1px solid var(--border)" }}>
            <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: "var(--radius)", background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
              <Icon name="filter" size="1.1rem" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{f.title}</span>
                {f.expires_at && new Date(f.expires_at).getTime() < now && (
                  <span className="badge" style={{ fontSize: "0.7rem" }}>{t.filter_expired}</span>
                )}
              </div>
              <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.4rem", alignItems: "center" }}>
                {f.context.map((c) => (
                  <span key={c} className="badge badge-accent" style={{ fontSize: "0.72rem" }}>
                    <Icon name={contextIcon(c)} size="0.75rem" style={{ marginRight: "0.3rem" }} /> {contextLabel(c)}
                  </span>
                ))}
                <span className="badge" style={{ fontSize: "0.72rem", color: actionColor(f.filter_action) }}>
                  <Icon name={actionIcon(f.filter_action)} size="0.75rem" color={actionColor(f.filter_action)} style={{ marginRight: "0.3rem" }} /> {actionLabel(f.filter_action)}
                </span>
              </div>
              {f.keywords.length > 0 && (
                <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
                  {f.keywords.map((k) => (
                    <span key={k.id ?? k.keyword} title={k.whole_word ? t.filter_whole_word : undefined} style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", color: "var(--text-secondary)" }}>
                      {k.keyword}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: "0.35rem", flexShrink: 0 }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setError(null); setIsNew(false); setEditing(JSON.parse(JSON.stringify(f))); }} aria-label={t.filter_edit}>
                <Icon name="pencil" />
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={deletingId === f.id} onClick={() => void handleDelete(f)} aria-label={t.filter_delete}>
                <Icon name="times" color="var(--danger)" />
              </button>
            </div>
          </div>
        ))
      )}

      {editing && (
        <FilterFormModal
          filter={editing}
          isNew={isNew}
          saving={saving}
          error={error}
          token={token}
          onClose={() => { setEditing(null); setError(null); }}
          onSaved={(saved) => {
            setFilters((prev) => {
              const exists = prev.some((f) => f.id === saved.id);
              return exists ? prev.map((f) => (f.id === saved.id ? saved : f)) : [saved, ...prev];
            });
            setEditing(null);
            window.dispatchEvent(new CustomEvent("cf-ap:filters-changed"));
          }}
          onError={setError}
          setSaving={setSaving}
        />
      )}
    </PageLayout>
  );
}

// ── Create / edit modal ──────────────────────────────────────────────────────

function FilterFormModal({
  filter,
  isNew,
  saving,
  error,
  token,
  onClose,
  onSaved,
  onError,
  setSaving,
}: {
  filter: Filter;
  isNew: boolean;
  saving: boolean;
  error: string | null;
  token: string | null;
  onClose: () => void;
  onSaved: (f: Filter) => void;
  onError: (e: string | null) => void;
  setSaving: (b: boolean) => void;
}) {
  const { t } = useLocale();
  const [title, setTitle] = useState(filter.title);
  const [context, setContext] = useState<FilterContext[]>(filter.context.length > 0 ? filter.context : ["home"]);
  const [action, setAction] = useState<FilterAction>(filter.filter_action);
  const [expirySeconds, setExpirySeconds] = useState<number | null>(() => {
    if (!filter.expires_at) return null;
    return Math.max(1800, Math.min(604800, Math.round((new Date(filter.expires_at).getTime() - Date.now()) / 1000 / 1800) * 1800));
  });
  const [keywords, setKeywords] = useState<FilterKeyword[]>(filter.keywords.length > 0 ? filter.keywords.map((k) => ({ ...k })) : [{ keyword: "", whole_word: true }]);

  function toggleContext(c: FilterContext) {
    setContext((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  function updateKeyword(i: number, patch: Partial<FilterKeyword>) {
    setKeywords((prev) => prev.map((k, j) => (j === i ? { ...k, ...patch } : k)));
  }

  async function handleSave() {
    if (!token || saving) return;
    if (!title.trim()) { onError(t.filter_title_required); return; }
    const validKeywords = keywords.filter((k) => k.keyword.trim());
    setSaving(true);
    onError(null);
    try {
      const payload = {
        title: title.trim(),
        context,
        filter_action: action,
        expires_in: expirySeconds,
        keywords_attributes: validKeywords.map((k) => ({ keyword: k.keyword.trim(), whole_word: k.whole_word })),
      };
      const url = isNew ? "/api/v2/filters" : `/api/v2/filters/${encodeURIComponent(filter.id)}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        onError(data.error ?? t.filter_save_error);
        return;
      }
      const saved = await res.json() as Filter;
      onSaved(saved);
    } catch {
      onError(t.filter_save_error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
      <div
        className="rounded-2xl shadow-2xl"
        style={{ width: "min(560px, 92vw)", maxHeight: "86vh", overflowY: "auto", background: "var(--bg)", border: "1px solid var(--border)", padding: "1.25rem" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
          <h3 style={{ fontWeight: 700, fontSize: "1.05rem" }}>{isNew ? t.filter_create : t.filter_edit}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label={t.profile_cancel}><Icon name="times" /></button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.3rem" }}>{t.filter_title}</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={256} placeholder={t.filter_title_placeholder} />
          </div>

          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.3rem" }}>{t.filter_context}</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
              {CONTEXTS.map((c) => (
                <label key={c} className="flex items-center gap-1" style={{ fontSize: "0.85rem", cursor: "pointer", padding: "0.3rem 0.6rem", background: context.includes(c) ? "var(--accent-bg)" : "var(--bg-elevated)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}>
                  <input type="checkbox" checked={context.includes(c)} onChange={() => toggleContext(c)} style={{ accentColor: "var(--accent)" }} />
                  {(() => { const map: Record<FilterContext, string> = { home: t.filter_context_home, notifications: t.filter_context_notifications, public: t.filter_context_public, thread: t.filter_context_thread, account: t.filter_context_account }; return map[c]; })()}
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={{ display: "block", fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.3rem" }}>{t.filter_action}</label>
              <select className="input" value={action} onChange={(e) => setAction(e.target.value as FilterAction)} style={{ width: "100%" }}>
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>{(() => { const map: Record<FilterAction, string> = { warn: t.filter_action_warn, hide: t.filter_action_hide, blur: t.filter_action_blur }; return map[a]; })()}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label style={{ display: "block", fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.3rem" }}>{t.filter_expiry}</label>
              <select className="input" value={expirySeconds ?? ""} onChange={(e) => setExpirySeconds(e.target.value === "" ? null : Number(e.target.value))} style={{ width: "100%" }}>
                {EXPIRIES.map((ex) => (
                  <option key={ex.seconds ?? "never"} value={ex.seconds ?? ""}>{t[ex.key as keyof typeof t] as string}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.3rem" }}>{t.filter_keywords}</label>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {keywords.map((k, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={k.keyword}
                    placeholder={t.filter_keyword_placeholder}
                    maxLength={512}
                    onChange={(e) => updateKeyword(i, { keyword: e.target.value })}
                  />
                  <label className="flex items-center gap-1" style={{ fontSize: "0.8rem", cursor: "pointer", whiteSpace: "nowrap" }} title={t.filter_whole_word_hint}>
                    <input type="checkbox" checked={k.whole_word} onChange={(e) => updateKeyword(i, { whole_word: e.target.checked })} style={{ accentColor: "var(--accent)" }} />
                    {t.filter_whole_word}
                  </label>
                  {keywords.length > 1 && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setKeywords((prev) => prev.filter((_, j) => j !== i))} aria-label={t.filter_remove_keyword}>
                      <Icon name="times" color="var(--danger)" />
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setKeywords((prev) => [...prev, { keyword: "", whole_word: true }])}>
                <Icon name="plus" /> {t.filter_add_keyword}
              </button>
            </div>
          </div>

          {error && <div style={{ color: "var(--danger)", fontSize: "0.85rem" }}>{error}</div>}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>{t.profile_cancel}</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "…" : t.filter_save}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}