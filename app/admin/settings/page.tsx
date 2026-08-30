"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/client-api";
import { useLocale } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { EmojiInput } from "@/components/EmojiInput";
import { EmojiTextarea } from "@/components/EmojiTextarea";
import { useLimits } from "@/lib/limits-client";

interface SettingsData {
  rules: { id: string; text: string }[];
  privacy_policy: string;
  terms_of_service: string;
  extended_description: string;
  languages: { code: string; name?: string; native_name?: string }[];
}

export default function AdminSettingsPage() {
  const router = useRouter();
  const { t } = useLocale();
  const limits = useLimits();
  const token = getToken();

  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newRule, setNewRule] = useState("");
  const [newLang, setNewLang] = useState("");

  async function fetchSettings() {
    if (!token) return;
    try {
      const res = await fetch("/api/v1/admin/instance_settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.push("/login"); return; }
      setData(await res.json() as SettingsData);
    } catch {
      router.push("/login");
    }
    setLoading(false);
  }

  useEffect(() => {
    Promise.resolve().then(() => void fetchSettings());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function handleSave() {
    if (!token || !data) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/v1/admin/instance_settings", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch { /* ignore */ }
    setSaving(false);
  }

  function addRule() {
    if (!data || !newRule.trim()) return;
    setData({ ...data, rules: [...data.rules, { id: crypto.randomUUID(), text: newRule.trim() }] });
    setNewRule("");
  }

  function removeRule(id: string) {
    if (!data) return;
    setData({ ...data, rules: data.rules.filter((r) => r.id !== id) });
  }

  function addLang() {
    if (!data || !newLang.trim()) return;
    const code = newLang.trim().toLowerCase().slice(0, 2);
    if (data.languages.some((l) => l.code === code)) { setNewLang(""); return; }
    setData({ ...data, languages: [...data.languages, { code, name: code, native_name: code }] });
    setNewLang("");
  }

  function removeLang(code: string) {
    if (!data) return;
    setData({ ...data, languages: data.languages.filter((l) => l.code !== code) });
  }

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "2rem" }}>{t.loading}</div>;
  }
  if (!data) return null;

  const inputStyle: React.CSSProperties = { width: "100%", padding: "0.5rem 0.75rem", fontSize: "0.85rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontFamily: "inherit" };
  const labelStyle: React.CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.375rem" };

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>
        <Icon name="cog" /> {t.admin_settings_title}
      </h1>
      <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        {t.admin_settings_desc}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", maxWidth: 640 }}>
        {/* Rules */}
        <div>
          <label style={labelStyle}>{t.admin_settings_rules}</label>
          {data.rules.length === 0 && (
            <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.5rem" }}>{t.admin_settings_rules_empty}</div>
          )}
          {data.rules.map((rule) => (
            <div key={rule.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.375rem" }}>
              <EmojiInput className="input" containerStyle={{ flex: 1 }} style={inputStyle} value={rule.text} onChange={(v) => setData({ ...data, rules: data.rules.map((r) => r.id === rule.id ? { ...r, text: v } : r) })} />
              <button type="button" className="btn btn-ghost btn-sm" aria-label={t.action_delete} style={{ color: "var(--danger)", flexShrink: 0 }} onClick={() => removeRule(rule.id)}><Icon name="trash" color="var(--danger)" /></button>
            </div>
          ))}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <EmojiInput className="input" containerStyle={{ flex: 1 }} style={inputStyle} value={newRule} onChange={setNewRule} placeholder={t.admin_settings_rule_ph} onKeyDown={(e) => { if (e.key === "Enter" && !e.defaultPrevented) { e.preventDefault(); addRule(); } }} />
            <button type="button" className="btn btn-outline btn-sm" onClick={addRule} disabled={!newRule.trim()}>{t.admin_settings_add_rule}</button>
          </div>
        </div>

        {/* Extended description */}
        <div>
          <label style={labelStyle}>{t.admin_settings_ext_desc}</label>
          <EmojiTextarea className="input" style={{ ...inputStyle, minHeight: 90 }} value={data.extended_description} onChange={(v) => setData({ ...data, extended_description: v })} />
        </div>

        {/* Privacy policy */}
        <div>
          <label style={labelStyle}>{t.admin_settings_privacy}</label>
          <EmojiTextarea className="input" style={{ ...inputStyle, minHeight: 120 }} value={data.privacy_policy} onChange={(v) => setData({ ...data, privacy_policy: v })} />
        </div>

        {/* Terms of service */}
        <div>
          <label style={labelStyle}>{t.admin_settings_tos}</label>
          <EmojiTextarea className="input" style={{ ...inputStyle, minHeight: 120 }} value={data.terms_of_service} onChange={(v) => setData({ ...data, terms_of_service: v })} />
        </div>

        {/* Languages */}
        <div>
          <label style={labelStyle}>{t.admin_settings_languages}</label>
          <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
            {data.languages.map((l) => (
              <span key={l.code} style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem", background: "var(--accent-bg)", color: "var(--accent)", borderRadius: "var(--radius)", padding: "0.25rem 0.5rem", fontSize: "0.8rem", fontWeight: 600 }}>
                {l.code.toUpperCase()}
                <button type="button" onClick={() => removeLang(l.code)} aria-label={t.action_delete} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: "0.8rem", padding: 0, lineHeight: 1 }}><Icon name="times" /></button>
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input className="input" style={inputStyle} value={newLang} onChange={(e) => setNewLang(e.target.value)} placeholder={t.admin_settings_lang_ph} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLang(); } }} maxLength={limits.maxLangCodeChars} />
            <button type="button" className="btn btn-outline btn-sm" onClick={addLang} disabled={!newLang.trim()}>{t.admin_settings_add_lang}</button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <button className="btn btn-primary btn-sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "…" : t.profile_save}
          </button>
          {saved && <span style={{ color: "var(--success)", fontSize: "0.875rem" }}>{t.settings_saved}</span>}
        </div>
      </div>
    </div>
  );
}