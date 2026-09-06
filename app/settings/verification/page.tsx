"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { SettingsHeader } from "@/components/SettingsHeader";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";
import type { Me } from "@/components/StatusCard";
import { Loading } from "@/components/Loading";

interface Field {
  name: string;
  value: string;
  verified_at: string | null;
}

interface Account extends Me {
  url: string;
  username: string;
  fields?: Field[];
  verified?: boolean;
  source?: { fields?: Field[] };
}

export default function VerificationPage() {
  const router = useRouter();
  const token = getToken();
  const { t } = useLocale();
  const [account, setAccount] = useState<Account | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    void fetch("/api/v1/accounts/verify_credentials", {
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => (res.ok ? res.json() as Promise<Account> : null)).then((a) => {
      if (a) { setAccount(a); setMe(a); }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCheck() {
    if (!token) return;
    setChecking(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/accounts/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const updated = await res.json() as Account;
        setAccount(updated);
        setMe(updated);
        const fields = updated.source?.fields && updated.source.fields.length > 0
          ? updated.source.fields
          : (updated.fields ?? []);
        const verifiedCount = fields.filter((f) => f.verified_at).length;
        if (fields.length === 0) {
          setMessage({ ok: false, text: t.settings_verification_checked_nofields });
        } else if (verifiedCount > 0) {
          setMessage({ ok: true, text: t.settings_verification_checked_ok.replace("{count}", String(verifiedCount)) });
        } else {
          setMessage({ ok: false, text: t.settings_verification_checked_none });
        }
      } else {
        setMessage({ ok: false, text: t.settings_verification_checked_failed });
      }
    } catch {
      setMessage({ ok: false, text: t.settings_verification_checked_failed });
    }
    setChecking(false);
  }

  const profileLink = account && account.url
    ? `${new URL(account.url).origin}/@${account.username}`
    : "";

// Fields for display: `source.fields` carries the plain-text values (the
// top-level `fields` array is HTML), so prefer it when present.
const accountFields =
  account && account.source?.fields && account.source.fields.length > 0
    ? account.source.fields
    : (account?.fields ?? []);

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/settings/verification" />}>
      <SettingsHeader />

      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: 640 }}>
        <div>
          <h2 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.25rem" }}>{t.settings_verification_title}</h2>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
            {t.settings_verification_desc}
          </p>
        </div>

        {/* Steps */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "1rem" }}>
          <div style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>
            <strong>{t.settings_verification_step1}</strong>
          </div>
          <div style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>
            <strong>{t.settings_verification_step2}</strong>
          </div>
          {profileLink && (
            <code
              style={{
                display: "block",
                background: "var(--bg-overlay)",
                borderRadius: "var(--radius-sm)",
                padding: "0.5rem 0.625rem",
                fontSize: "0.8rem",
                overflowWrap: "anywhere",
              }}
            >
              {`<a href="${profileLink}" rel="me">${profileLink}</a>`}
            </code>
          )}
          <div style={{ fontSize: "0.85rem", lineHeight: 1.5 }}>
            <strong>{t.settings_verification_step2_alt}</strong>
          </div>
          {profileLink && (
            <code
              style={{
                display: "block",
                background: "var(--bg-overlay)",
                borderRadius: "var(--radius-sm)",
                padding: "0.5rem 0.625rem",
                fontSize: "0.8rem",
                overflowWrap: "anywhere",
              }}
            >
              {`<link rel="me" href="${profileLink}">`}
            </code>
          )}
        </div>

        {message && (
          <div
            style={{
              fontSize: "0.875rem",
              color: message.ok ? "var(--success)" : "var(--warning)",
              background: message.ok ? "rgba(52,211,153,0.1)" : "rgba(251,191,36,0.12)",
              padding: "0.75rem 1rem",
              borderRadius: "var(--radius)",
            }}
          >
            {message.text}
          </div>
        )}

        {/* Fields + verification status */}
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <label style={{ fontWeight: 600, fontSize: "0.875rem" }}>{t.profile_edit_fields}</label>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleCheck()} disabled={checking}>
              {checking ? t.settings_verification_checking : t.settings_verification_check}
            </button>
          </div>

          {!account ? (
            <Loading />
          ) : accountFields.length === 0 ? (
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: 0 }}>{t.settings_verification_no_fields}</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {accountFields.map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.625rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.625rem 0.75rem" }}>
                  <Icon
                    name="check-circle"
                    color={f.verified_at ? "var(--success)" : "var(--text-muted)"}
                    size="1rem"
                    style={{ flexShrink: 0 }}
                    title={f.verified_at ? t.verified_field : undefined}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.value}</div>
                  </div>
                  <span
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 600,
                      color: f.verified_at ? "var(--success)" : "var(--text-muted)",
                      flexShrink: 0,
                    }}
                  >
                    {f.verified_at ? t.settings_verification_verified : t.settings_verification_not_verified}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}