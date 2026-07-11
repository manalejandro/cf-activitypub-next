"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";

export default function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const { t, locale, setLocale } = useLocale();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (password !== confirmPassword) {
      setError(t.register_password_mismatch);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      const data = await res.json() as { error?: string };

      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }

      setSuccess(true);
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

  if (!token) {
    return (
      <div
        className="flex flex-col items-center justify-center min-h-screen px-4"
        style={{ background: "var(--bg)" }}
      >
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 mb-8">
            <Link href="/">
              <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
            </Link>
          </div>
          <div className="card p-8">
            <div style={inlineError}>{t.reset_password_invalid}</div>
          </div>
          <p style={{ textAlign: "center", marginTop: "1.25rem" }}>
            <Link href="/login" style={{ color: "var(--accent)", fontSize: "0.875rem" }}>
              {t.register_signin}
            </Link>
          </p>
        </div>
      </div>
    );
  }

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
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.reset_password_title}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
            {t.reset_password_sub}
          </p>
        </div>

        <div className="card p-8">
          {success ? (
            <div style={inlineSuccess}>{t.reset_password_success}</div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {error && <div style={inlineError}>{error}</div>}

              <div className="flex flex-col gap-2">
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.register_password}
                </label>
                <input
                  type="password"
                  className="input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  minLength={8}
                />
              </div>

              <div className="flex flex-col gap-2">
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.register_confirm_password}
                </label>
                <input
                  type="password"
                  className="input"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  minLength={8}
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
              >
                {loading ? t.login_submitting : t.reset_password_submit}
              </button>
            </form>
          )}
        </div>

        {success && (
          <p style={{ textAlign: "center", marginTop: "1.25rem", fontSize: "0.875rem", color: "var(--text-secondary)" }}>
            <Link href="/login" style={{ color: "var(--accent)" }}>
              {t.register_signin}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
