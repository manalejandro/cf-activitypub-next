"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";

export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t, locale, setLocale } = useLocale();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        setError(data.error ?? "Something went wrong");
        return;
      }

      setSent(true);
    } catch {
      setError(t.network_error);
    } finally {
      setLoading(false);
    }
  }

  const inlineError = {
    background: "rgba(248,113,113,0.1)",
    border: "1px solid rgba(248,113,113,0.3)",
    color: "var(--danger)",
    borderRadius: "var(--radius)",
    padding: "0.625rem 0.875rem",
    fontSize: "0.875rem",
  };

  const inlineSuccess = {
    background: "rgba(52,211,153,0.1)",
    border: "1px solid rgba(52,211,153,0.3)",
    color: "var(--success, #34d399)",
    borderRadius: "var(--radius)",
    padding: "0.625rem 0.875rem",
    fontSize: "0.875rem",
  };

  return (
    <div
      className="flex flex-col items-center justify-center min-h-screen px-4"
      style={{ background: "var(--bg)" }}
    >
      <div style={{ position: "absolute", top: "1rem", right: "1rem", display: "flex", gap: "0.375rem" }}>
        <button
          onClick={() => setLocale("en")}
          className="btn btn-ghost btn-sm"
          style={{
            fontWeight: locale === "en" ? 700 : 400,
            background: locale === "en" ? "var(--accent-bg)" : undefined,
            color: locale === "en" ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          EN
        </button>
        <button
          onClick={() => setLocale("es")}
          className="btn btn-ghost btn-sm"
          style={{
            fontWeight: locale === "es" ? 700 : 400,
            background: locale === "es" ? "var(--accent-bg)" : undefined,
            color: locale === "es" ? "var(--accent)" : "var(--text-muted)",
          }}
        >
          ES
        </button>
      </div>

      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <Link href="/">
            <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
          </Link>
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.forgot_password_title}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0, textAlign: "center" }}>
            {t.forgot_password_sub}
          </p>
        </div>

        <div className="card p-8">
          {sent ? (
            <div style={inlineSuccess}>{t.forgot_password_sent}</div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {error && <div style={inlineError}>{error}</div>}

              <div className="flex flex-col gap-2">
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.register_email}
                </label>
                <input
                  type="email"
                  className="input"
                  placeholder={t.forgot_password_email_ph}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? t.login_submitting : t.forgot_password_submit}
              </button>
            </form>
          )}
        </div>

        <p style={{ textAlign: "center", marginTop: "1.25rem", fontSize: "0.875rem", color: "var(--text-secondary)" }}>
          <Link href="/login" style={{ color: "var(--accent)" }}>
            {t.register_signin}
          </Link>
        </p>
      </div>
    </div>
  );
}
