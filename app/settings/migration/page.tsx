"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { SettingsHeader } from "@/components/SettingsHeader";
import { useLocale, translateKey } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  moved?: { acct: string } | null;
}

export default function MigrationPage() {
  const router = useRouter();
  const token = getToken();
  const { t } = useLocale();
  const [me, setMe] = useState<Me | null>(null);
  const [targetAcct, setTargetAcct] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [aliases, setAliases] = useState<{ uri: string; acct: string }[]>([]);
  const [aliasInput, setAliasInput] = useState("");
  const [aliasBusy, setAliasBusy] = useState(false);
  const [aliasResult, setAliasResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    async function fetchMe() {
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }
    void fetchMe();
    async function fetchAliases() {
      const res = await fetch("/api/v1/accounts/aliases", { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = (await res.json()) as { aliases?: { uri: string; acct: string }[] };
        setAliases(data.aliases ?? []);
      }
    }
    void fetchAliases();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Destination half of a profile move: the alias proves the user controls the
  // old account, and the old server checks it before accepting the Move.
  async function handleAddAlias() {
    if (!token || !aliasInput.trim()) return;
    setAliasBusy(true);
    setAliasResult(null);
    try {
      const res = await fetch("/api/v1/accounts/aliases", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ acct: aliasInput.trim() }),
      });
      const data = (await res.json()) as { aliases?: { uri: string; acct: string }[]; acct?: string; error_code?: string; error?: string };
      if (res.ok) {
        setAliases(data.aliases ?? []);
        setAliasInput("");
        setAliasResult({ ok: true, message: t.settings_aliases_created.replace("{acct}", data.acct ?? "") });
      } else {
        setAliasResult({ ok: false, message: translateKey(t, data.error_code, data.error) ?? t.settings_aliases_failed });
      }
    } catch {
      setAliasResult({ ok: false, message: t.settings_aliases_failed });
    }
    setAliasBusy(false);
  }

  async function handleRemoveAlias(uri: string) {
    if (!token) return;
    setAliasBusy(true);
    setAliasResult(null);
    try {
      const res = await fetch(`/api/v1/accounts/aliases?uri=${encodeURIComponent(uri)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { aliases?: { uri: string; acct: string }[]; error_code?: string; error?: string };
      if (res.ok) {
        setAliases(data.aliases ?? []);
        setAliasResult({ ok: true, message: t.settings_aliases_deleted });
      } else {
        setAliasResult({ ok: false, message: translateKey(t, data.error_code, data.error) ?? t.settings_aliases_failed });
      }
    } catch {
      setAliasResult({ ok: false, message: t.settings_aliases_failed });
    }
    setAliasBusy(false);
  }

  async function handleMigrate() {
    if (!token) return;
    setMigrating(true);
    setResult(null);
    try {
      const res = await fetch("/api/v1/accounts/migrate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ target_acct: targetAcct }),
      });
      const data = await res.json() as { error?: string; moved_to?: string; migrated_followers?: number; delivered_to?: number };
      if (res.ok) {
        setResult({
          ok: true,
          message: t.settings_migration_result
            .replace("{moved}", data.moved_to ?? "")
            .replace("{followers}", String(data.migrated_followers ?? 0))
            .replace("{servers}", String(data.delivered_to ?? 0)),
        });
      } else {
        setResult({ ok: false, message: data.error ?? t.settings_migration_failed });
      }
    } catch {
      setResult({ ok: false, message: t.settings_migration_failed });
    }
    setMigrating(false);
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/settings/migration" />}>
      <SettingsHeader />

      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: 560 }}>
        {me?.moved ? (
          <div style={{ background: "rgba(251,191,36,0.12)", color: "var(--warning)", padding: "0.75rem 1rem", borderRadius: "var(--radius)", fontSize: "0.875rem" }}>
            {t.settings_migration_moved} <strong>@{me.moved.acct}</strong>.
          </div>
        ) : (
          <>
            <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t.settings_migration_desc}
            </p>
            <div>
              <label style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.375rem" }}>{t.settings_migration_target}</label>
              <input
                className="input"
                placeholder="user@example.com"
                value={targetAcct}
                onChange={(e) => setTargetAcct(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <button className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => void handleMigrate()} disabled={migrating || !targetAcct}>
              {migrating ? "…" : t.settings_migration_button}
            </button>
            {result && (
              <div style={{ fontSize: "0.875rem", color: result.ok ? "var(--success)" : "var(--danger)", background: result.ok ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)", padding: "0.75rem 1rem", borderRadius: "var(--radius)" }}>
                {result.message}
              </div>
            )}
          </>
        )}

        {/* What moves and what does not (Mastodon's `migrations.other_data`). */}
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
          {t.settings_migration_note}{" "}
          <Link href="/settings/import-export" style={{ color: "var(--accent)" }}>
            {t.settings_tab_import}
          </Link>
        </p>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <h2 style={{ fontSize: "1rem", margin: 0 }}>{t.settings_aliases_title}</h2>
          <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", lineHeight: 1.5, margin: 0 }}>{t.settings_aliases_hint}</p>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              className="input"
              placeholder={t.settings_aliases_placeholder}
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm" onClick={() => void handleAddAlias()} disabled={aliasBusy || !aliasInput.trim()}>
              {aliasBusy ? "…" : t.settings_aliases_add}
            </button>
          </div>
          {aliases.length === 0 ? (
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>{t.settings_aliases_empty}</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.375rem" }}>
              {aliases.map((alias) => (
                <li key={alias.uri} style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.875rem" }}>
                  <span style={{ flex: 1, overflowWrap: "anywhere" }}>{alias.acct}</span>
                  <button className="btn btn-outline btn-sm" onClick={() => void handleRemoveAlias(alias.uri)} disabled={aliasBusy}>
                    {t.settings_aliases_remove}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {aliasResult && (
            <div style={{ fontSize: "0.875rem", color: aliasResult.ok ? "var(--success)" : "var(--danger)", background: aliasResult.ok ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)", padding: "0.75rem 1rem", borderRadius: "var(--radius)" }}>
              {aliasResult.message}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}