"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { SettingsHeader } from "@/components/SettingsHeader";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";

interface Preferences {
  "posting:default:visibility": string;
  "posting:default:sensitive": boolean;
  "posting:default:language": string | null;
  "posting:default:quote_policy": string;
  "reading:expand:media": string;
  "reading:expand:spoilers": boolean;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  locked: boolean;
  bot: boolean;
  source?: {
    auto_delete_after?: number | null;
  };
}

export default function SettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [locked, setLocked] = useState(false);
  const [bot, setBot] = useState(false);
  const [autoDelete, setAutoDelete] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const token = getToken();
  const { t, locale } = useLocale();

  useEffect(() => {
    async function fetchMe() {
      if (!token) return;
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as Me;
        setMe(data);
        setLocked(Boolean(data.locked));
        setBot(Boolean(data.bot));
        setAutoDelete(data.source?.auto_delete_after ?? 0);
      }
    }

    async function fetchPrefs() {
      if (!token) return;
      const res = await fetch("/api/v1/preferences", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setPrefs(await res.json() as Preferences);
      setLoading(false);
    }

    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchPrefs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    if (!token || !prefs) return;
    setSaving(true);
    // Persist the Mastodon-compatible preferences. The posting language is not
    // user-editable here: it always mirrors the interface language selected in
    // the sidebar (locale lives in localStorage on this instance).
    const prefsRes = await fetch("/api/v1/preferences", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...prefs, "posting:default:language": locale }),
    });
    // Save the account-level settings (locked + auto-delete) via the profile
    // update endpoint, which persists them on the actors table.
    const form = new FormData();
    form.append("locked", locked ? "true" : "false");
    form.append("bot", bot ? "true" : "false");
    form.append("auto_delete_after", autoDelete > 0 ? String(autoDelete) : "");
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (prefsRes.ok && res.ok) {
      const updated = await res.json() as Me;
      setLocked(Boolean(updated.locked));
      setBot(Boolean(updated.bot));
      setAutoDelete(updated.source?.auto_delete_after ?? 0);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  }

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    if (!prefs) return;
    setPrefs({ ...prefs, [key]: value });
  }

  if (loading) {
    return (
      <PageLayout sidebar={<Sidebar me={me} currentPath="/settings" />}>
        <div style={{ color: "var(--text-muted)" }}>{t.loading}</div>
      </PageLayout>
    );
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/settings" />}>
        <SettingsHeader />

        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: 560 }}>
          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.375rem" }}>{t.settings_visibility}</label>
            <select
              className="input"
              value={prefs?.["posting:default:visibility"] ?? "public"}
              onChange={(e) => update("posting:default:visibility", e.target.value)}
              style={{ width: "100%" }}
            >
              <option value="public">{t.vis_public}</option>
              <option value="unlisted">{t.vis_unlisted}</option>
              <option value="followers">{t.vis_followers}</option>
              <option value="direct">{t.vis_direct}</option>
            </select>
          </div>

          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.375rem" }}>{t.settings_language}</label>
            <select className="input" value={locale} disabled style={{ width: "100%", opacity: 0.6 }}>
              <option value="en">EN</option>
              <option value="es">ES</option>
            </select>
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              {t.settings_language_hint}
            </p>
          </div>

          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.375rem" }}>{t.settings_quote_policy}</label>
            <select
              className="input"
              value={prefs?.["posting:default:quote_policy"] ?? "followers"}
              onChange={(e) => update("posting:default:quote_policy", e.target.value)}
              style={{ width: "100%" }}
            >
              <option value="public">{t.quote_policy_public}</option>
              <option value="followers">{t.quote_policy_followers}</option>
              <option value="followed">{t.quote_policy_followed}</option>
              <option value="nobody">{t.quote_policy_nobody}</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="sensitive"
              checked={prefs?.["posting:default:sensitive"] ?? false}
              onChange={(e) => update("posting:default:sensitive", e.target.checked)}
            />
            <label htmlFor="sensitive" style={{ fontSize: "0.875rem" }}>{t.settings_sensitive}</label>
          </div>

          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.375rem" }}>{t.settings_expand_media}</label>
            <select
              className="input"
              value={prefs?.["reading:expand:media"] ?? "default"}
              onChange={(e) => update("reading:expand:media", e.target.value)}
              style={{ width: "100%" }}
            >
              <option value="default">{t.settings_expand_media_default}</option>
              <option value="show_all">{t.settings_expand_media_show}</option>
              <option value="hide_all">{t.settings_expand_media_hide}</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="spoilers"
              checked={prefs?.["reading:expand:spoilers"] ?? false}
              onChange={(e) => update("reading:expand:spoilers", e.target.checked)}
            />
            <label htmlFor="spoilers" style={{ fontSize: "0.875rem" }}>{t.settings_expand_spoilers}</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="locked"
              checked={locked}
              onChange={(e) => setLocked(e.target.checked)}
            />
            <label htmlFor="locked" style={{ fontSize: "0.875rem" }}>{t.settings_approve_follows}</label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="bot"
              checked={bot}
              onChange={(e) => setBot(e.target.checked)}
            />
            <label htmlFor="bot" style={{ fontSize: "0.875rem" }}>{t.settings_bot}</label>
          </div>

          <div>
            <label style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.375rem" }}>{t.settings_auto_delete}</label>
            <select
              className="input"
              value={autoDelete}
              onChange={(e) => setAutoDelete(Number(e.target.value))}
              style={{ width: "100%" }}
            >
              <option value={0}>{t.profile_edit_auto_delete_off}</option>
              <option value={3600}>{t.profile_edit_auto_delete_1h}</option>
              <option value={21600}>{t.profile_edit_auto_delete_6h}</option>
              <option value={86400}>{t.profile_edit_auto_delete_1d}</option>
              <option value={259200}>{t.profile_edit_auto_delete_3d}</option>
              <option value={604800}>{t.profile_edit_auto_delete_1w}</option>
              <option value={2592000}>{t.profile_edit_auto_delete_30d}</option>
            </select>
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              {t.profile_edit_auto_delete_hint}
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <button className="btn btn-primary btn-sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "…" : t.profile_save}
            </button>
            {saved && <span style={{ color: "var(--success)", fontSize: "0.875rem" }}>{t.settings_saved}</span>}
          </div>
        </div>
    </PageLayout>
  );
}
