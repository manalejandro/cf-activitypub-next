"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { useLocale } from "@/lib/i18n";

interface Preferences {
  "posting:default:visibility": string;
  "posting:default:sensitive": boolean;
  "posting:default:language": string | null;
  "reading:expand:media": string;
  "reading:expand:spoilers": boolean;
}

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
  const { t } = useLocale();

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetchMe();
    void fetchPrefs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMe() {
    if (!token) return;
    const res = await fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchPrefs() {
    if (!token) return;
    const res = await fetch("/api/v1/preferences", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) setPrefs(await res.json() as Preferences);
    setLoading(false);
  }

  async function handleSave() {
    if (!token || !prefs) return;
    setSaving(true);
    const res = await fetch("/api/v1/preferences", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    });
    if (res.ok) {
      setPrefs(await res.json() as Preferences);
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
      <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
        <Sidebar me={me} currentPath="/settings" />
        <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text-muted)" }}>{t.loading}</div>
        </main>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <Sidebar me={me} currentPath="/settings" />
      <main style={{ flex: 1, maxWidth: 600, borderRight: "1px solid var(--border)" }}>
        <div className="sticky top-0" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)", padding: "1rem", zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 className="text-lg font-bold">{t.settings_title}</h1>
          <button className="btn btn-primary btn-sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "…" : saved ? "✓" : t.profile_save}
          </button>
        </div>
        {saved && (
          <div style={{ padding: "0.5rem 1rem", background: "var(--accent-bg)", color: "var(--accent)", fontSize: "0.875rem" }}>
            {t.settings_saved}
          </div>
        )}
        <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
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
        </div>
      </main>
    </div>
  );
}
