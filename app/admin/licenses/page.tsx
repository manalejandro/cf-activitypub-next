"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { licenseName } from "@/lib/license-client";
import { LicenseBadge } from "@/components/LicenseBadge";
import type { ClientLicense } from "@/lib/license-client";

interface AdminLicense extends ClientLicense {
  sortOrder?: number;
}

export default function AdminLicensesPage() {
  const router = useRouter();
  const { t } = useLocale();
  const token = getToken();

  const [licenses, setLicenses] = useState<AdminLicense[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newBadge, setNewBadge] = useState("");
  const [editing, setEditing] = useState<AdminLicense | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editBadge, setEditBadge] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // Catalogue management is full-admin only (instance policy), like relays.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetch("/api/v1/accounts/verify_credentials", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null) as Promise<{ roles?: { name: string }[] } | null>)
      .then((me) => setIsAdmin((me?.roles?.[0]?.name ?? "").toLowerCase() === "admin"))
      .catch(() => setIsAdmin(false));
  }, [token]);

  const fetchLicenses = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/licenses", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { router.push("/login"); return; }
      const data = await res.json() as { licenses: AdminLicense[] };
      setLicenses(data.licenses ?? []);
    } catch {
      if (!silent) router.push("/login");
    }
    if (!silent) setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    Promise.resolve().then(() => void fetchLicenses());
  }, [fetchLicenses]);

  function flash(key: string) {
    setNotice(t[key as keyof Translations] as string);
    window.setTimeout(() => setNotice(null), 3000);
  }

  function flashError(status: number) {
    if (status === 403) return flash("admin_licenses_admin_only");
    if (status === 422) return flash("admin_licenses_error_input");
    flash("admin_licenses_error_failed");
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !newName.trim() || !newUrl.trim() || busy) return;
    setBusy("add");
    try {
      const res = await fetch("/api/v1/admin/licenses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", name: newName.trim(), url: newUrl.trim(), badge_text: newBadge.trim() }),
      });
      if (res.status === 401) { router.push("/login"); return; }
      if (!res.ok) { flashError(res.status); } else {
        flash("admin_licenses_notice_added");
        setNewName("");
        setNewUrl("");
        setNewBadge("");
        setAdding(false);
        await fetchLicenses(true);
      }
    } catch { /* ignore */ }
    setBusy(null);
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !editing || busy) return;
    setBusy(editing.id);
    try {
      const res = await fetch("/api/v1/admin/licenses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", id: editing.id, name: editName.trim(), url: editUrl.trim(), badge_text: editBadge.trim() }),
      });
      if (res.status === 401) { router.push("/login"); return; }
      if (!res.ok) { flashError(res.status); } else {
        flash("admin_licenses_notice_updated");
        setEditing(null);
        await fetchLicenses(true);
      }
    } catch { /* ignore */ }
    setBusy(null);
  }

  async function remove(license: AdminLicense) {
    if (!token || busy) return;
    if (!window.confirm(t.admin_licenses_remove_confirm)) return;
    setBusy(license.id);
    try {
      const res = await fetch("/api/v1/admin/licenses", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id: license.id }),
      });
      if (res.status === 401) { router.push("/login"); return; }
      if (!res.ok) { flashError(res.status); } else {
        flash("admin_licenses_notice_removed");
        await fetchLicenses(true);
      }
    } catch { /* ignore */ }
    setBusy(null);
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        <Icon name="balance-scale" /> {t.admin_licenses}
        <span style={{ fontSize: "0.9rem", color: "var(--text-muted)", fontWeight: 400, marginLeft: "0.5rem" }}>
          ({licenses.length})
        </span>
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "1.25rem" }}>
        {t.admin_licenses_desc}
      </p>

      {notice && (
        <div style={{ marginBottom: "1rem", padding: "0.5rem 0.75rem", borderRadius: "var(--radius-sm)", background: "var(--accent-bg)", color: "var(--accent)", fontSize: "0.85rem" }}>
          {notice}
        </div>
      )}

      {!isAdmin && (
        <div style={{ marginBottom: "1rem", padding: "0.5rem 0.75rem", borderRadius: "var(--radius-sm)", background: "rgba(251,191,36,0.12)", color: "var(--warning)", fontSize: "0.85rem" }}>
          {t.admin_licenses_admin_only}
        </div>
      )}

      {isAdmin && (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          {!adding ? (
            <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              {t.admin_licenses_add}
            </button>
          ) : (
            <form onSubmit={(e) => void handleAdd(e)} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", flex: 1, minWidth: 320, alignItems: "center" }}>
              <input
                className="input"
                placeholder={t.admin_licenses_name_ph}
                aria-label={t.admin_licenses_name_ph}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                style={{ maxWidth: 200 }}
              />
              <input
                className="input"
                placeholder={t.admin_licenses_url_ph}
                aria-label={t.admin_licenses_url_ph}
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                style={{ flex: 1, minWidth: 240 }}
              />
              <input
                className="input"
                placeholder={t.admin_licenses_badge_ph}
                aria-label={t.admin_licenses_badge_ph}
                value={newBadge}
                onChange={(e) => setNewBadge(e.target.value)}
                maxLength={12}
                style={{ maxWidth: 160 }}
              />
              <span title={t.admin_licenses_col_badge} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 44, padding: "0.3rem 0.5rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)" }}>
                <LicenseBadge license={{ badgeText: newBadge, url: newUrl }} size="1rem" />
              </span>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!newName.trim() || !newUrl.trim() || busy === "add"}>
                {busy === "add" ? "…" : t.admin_licenses_add}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAdding(false); setNewBadge(""); }}>
                {t.profile_cancel}
              </button>
            </form>
          )}
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_licenses_loading}</div>
      ) : licenses.length === 0 ? (
        <div style={{ color: "var(--text-muted)", padding: "2rem 0" }}>{t.admin_licenses_empty}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_licenses_col_license}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_licenses_col_badge}</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_licenses_col_url}</th>
                <th style={{ textAlign: "right", padding: "0.5rem 0.75rem", fontWeight: 600 }}>{t.admin_col_actions}</th>
              </tr>
            </thead>
            <tbody>
              {licenses.map((license) => {
                const busyRow = busy === license.id;
                if (editing?.id === license.id) {
                  return (
                    <tr key={license.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td colSpan={4} style={{ padding: "0.625rem 0.75rem" }}>
                        <form onSubmit={(e) => void handleUpdate(e)} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                          <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} aria-label={t.admin_licenses_name_ph} style={{ maxWidth: 200 }} autoFocus />
                          <input className="input" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} aria-label={t.admin_licenses_url_ph} style={{ flex: 1, minWidth: 240 }} />
                          <input className="input" value={editBadge} onChange={(e) => setEditBadge(e.target.value)} placeholder={t.admin_licenses_badge_ph} aria-label={t.admin_licenses_badge_ph} maxLength={12} style={{ maxWidth: 160 }} />
                          <span title={t.admin_licenses_col_badge} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 44, padding: "0.3rem 0.5rem", background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)" }}>
                            <LicenseBadge license={{ badgeText: editBadge, url: editUrl }} size="1rem" />
                          </span>
                          <button type="submit" className="btn btn-primary btn-sm" disabled={busyRow}>{busyRow ? "…" : t.profile_save}</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>{t.profile_cancel}</button>
                        </form>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={license.id} style={{ borderBottom: "1px solid var(--border)", transition: "background 0.1s" }}
                    onMouseOver={(e) => (e.currentTarget as HTMLElement).style.background = "var(--accent-bg)"}
                    onMouseOut={(e) => (e.currentTarget as HTMLElement).style.background = ""}
                  >
                    <td style={{ padding: "0.625rem 0.75rem", fontWeight: 600 }}>
                      {licenseName(t, license)}
                      <a href={`/licenses/${license.id}`} target="_blank" rel="noopener noreferrer" style={{ marginLeft: "0.4rem", color: "var(--text-muted)", fontSize: "0.75rem" }}>
                        <Icon name="external-link" />
                      </a>
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      <LicenseBadge license={license} size="1.1rem" />
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem" }}>
                      <a href={license.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                        {license.url}
                      </a>
                    </td>
                    <td style={{ padding: "0.625rem 0.75rem", textAlign: "right", whiteSpace: "nowrap" }}>
                      {isAdmin && (
                        <>
                          <button className="btn btn-outline btn-sm" style={{ marginRight: "0.35rem" }}
                            disabled={busyRow}
                            onClick={() => { setEditing(license); setEditName(license.name); setEditUrl(license.url); setEditBadge(license.badgeText ?? ""); }}>
                            {t.admin_licenses_btn_edit}
                          </button>
                          <button className="btn btn-danger btn-sm" disabled={busyRow} onClick={() => void remove(license)}>
                            {t.admin_licenses_btn_remove}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
