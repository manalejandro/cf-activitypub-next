"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { SettingsHeader } from "@/components/SettingsHeader";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { Icon } from "@/components/Icon";

interface Connection {
  id: string;
  appName: string | null;
  appWebsite: string | null;
  scope: string;
  createdAt: string;
  expiresAt: string | null;
  isWebSession: boolean;
  isCurrent: boolean;
}

export default function AuthorizedAppsPage() {
  const router = useRouter();
  const token = getToken();
  const { t } = useLocale();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    async function load() {
      const res = await fetch("/api/oauth/authorized", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { connections: Connection[] };
        setConnections(data.connections);
      } else {
        setConnections([]);
      }
    }
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRevoke(conn: Connection) {
    if (!token) return;
    setRevokingId(conn.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/oauth/authorized/${encodeURIComponent(conn.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json() as { revokedCurrent: boolean };
        setConnections((prev) => (prev ?? []).filter((c) => c.id !== conn.id));
        if (data.revokedCurrent) {
          setMessage({ ok: true, text: t.settings_apps_revoked_current });
          setTimeout(() => { window.location.href = "/login"; }, 1500);
        } else {
          setMessage({ ok: true, text: t.settings_apps_revoked });
        }
      } else {
        setMessage({ ok: false, text: t.settings_apps_revoke_failed });
      }
    } catch {
      setMessage({ ok: false, text: t.settings_apps_revoke_failed });
    }
    setRevokingId(null);
  }

  function formatDate(iso: string | null): string {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return "—";
    }
  }

  return (
    <PageLayout sidebar={<Sidebar me={null} currentPath="/settings/authorized-apps" />}>
      <SettingsHeader />

      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: 560 }}>
        <div>
          <h2 style={{ fontWeight: 600, fontSize: "0.95rem", marginBottom: "0.25rem" }}>{t.settings_apps_title}</h2>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
            {t.settings_apps_desc}
          </p>
        </div>

        {message && (
          <div
            style={{
              fontSize: "0.875rem",
              color: message.ok ? "var(--success)" : "var(--danger)",
              background: message.ok ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)",
              padding: "0.75rem 1rem",
              borderRadius: "var(--radius)",
            }}
          >
            {message.text}
          </div>
        )}

        {connections === null ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>{t.loading}</div>
        ) : connections.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "var(--text-muted)" }}>
            {t.settings_apps_empty}
          </div>
        ) : (
          connections.map((conn) => (
            <div
              key={conn.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.875rem",
                padding: "0.875rem 1rem",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
              }}
            >
              <div
                style={{
                  width: 40, height: 40, flexShrink: 0, borderRadius: "var(--radius)",
                  background: "var(--bg-elevated)", display: "flex", alignItems: "center",
                  justifyContent: "center", color: "var(--accent)",
                }}
              >
                <Icon name="globe" size="1.1rem" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                  {conn.appName ?? t.settings_apps_web_session}
                  {conn.isCurrent && (
                    <span style={{ fontSize: "0.75rem", color: "var(--accent)", marginLeft: "0.5rem", fontWeight: 600 }}>
                      · {t.settings_apps_current}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  {conn.appWebsite && (
                    <span>
                      {conn.appWebsite} ·{" "}
                    </span>
                  )}
                  {t.settings_apps_scope_label} {conn.scope}
                </div>
                <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                  {formatDate(conn.createdAt)}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                style={{
                  background: "var(--danger, #e11d48)", color: "#fff", border: "none",
                  borderRadius: "var(--radius)", padding: "0.35rem 0.875rem", cursor: "pointer", fontWeight: 600,
                  flexShrink: 0,
                }}
                disabled={revokingId === conn.id}
                onClick={() => void handleRevoke(conn)}
              >
                {revokingId === conn.id ? "…" : t.settings_apps_revoke}
              </button>
            </div>
          ))
        )}
      </div>
    </PageLayout>
  );
}