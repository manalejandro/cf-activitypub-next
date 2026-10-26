"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { SettingsHeader } from "@/components/SettingsHeader";
import { useLocale } from "@/lib/i18n";
import { getToken, clearToken } from "@/lib/client-api";

interface Me {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
}

export default function DeleteAccountPage() {
  const router = useRouter();
  const token = getToken();
  const { t } = useLocale();
  const [me, setMe] = useState<Me | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!token) { router.push("/login"); return; }
    async function fetchMe() {
      const res = await fetch("/api/v1/accounts/verify_credentials", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setMe(await res.json() as Me);
    }
    void fetchMe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmed = me ? confirmText.trim() === me.username : false;

  async function handleDelete() {
    if (!token || !confirmed) return;
    setDeleting(true);
    setResult(null);
    try {
      const res = await fetch("/api/v1/accounts/delete", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setResult({ ok: true, message: t.settings_delete_done });
        await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
        // Drop the localStorage API-token copy (the cookie is expired by the
        // delete/logout endpoints themselves).
        clearToken();
        setTimeout(() => { window.location.href = "/login"; }, 1500);
      } else {
        const data = await res.json() as { error?: string };
        setResult({ ok: false, message: data.error ?? t.settings_delete_failed });
      }
    } catch {
      setResult({ ok: false, message: t.settings_delete_failed });
    }
    setDeleting(false);
  }

  return (
    <PageLayout sidebar={<Sidebar me={me} currentPath="/settings/delete-account" />}>
      <SettingsHeader />

      <div style={{ padding: "1rem", display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: 560 }}>
        <div style={{ background: "rgba(248,113,113,0.12)", color: "var(--danger)", padding: "0.75rem 1rem", borderRadius: "var(--radius)", fontSize: "0.875rem" }}>
          {t.settings_delete_warning}
        </div>
        <p style={{ fontSize: "0.875rem", color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t.settings_delete_desc}
        </p>
        <div>
          <label style={{ display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.375rem" }}>
            {t.settings_delete_confirm_label} {me ? <strong>@{me.username}</strong> : null}
          </label>
          <input
            className="input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={deleting}
            style={{ width: "100%" }}
          />
        </div>
        <button
          className="btn btn-danger btn-sm"
          style={{ alignSelf: "flex-start" }}
          onClick={() => void handleDelete()}
          disabled={deleting || !confirmed}
        >
          {deleting ? "…" : t.settings_delete_button}
        </button>
        {result && (
          <div style={{ fontSize: "0.875rem", color: result.ok ? "var(--success)" : "var(--danger)", background: result.ok ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)", padding: "0.75rem 1rem", borderRadius: "var(--radius)" }}>
            {result.message}
          </div>
        )}
      </div>
    </PageLayout>
  );
}