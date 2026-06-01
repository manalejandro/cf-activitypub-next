"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useLocale } from "@/lib/i18n";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t, locale, setLocale } = useLocale();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "password", username: email, password }),
      });

      const data = await res.json() as { access_token?: string; error?: string };

      if (!res.ok || !data.access_token) {
        setError(data.error ?? "Invalid credentials");
        return;
      }

      // Store token & redirect to home feed
      localStorage.setItem("access_token", data.access_token);
      window.location.href = "/home";
    } catch {
      setError(t.network_error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-4" style={{ background: "var(--bg)" }}>
      {/* Language toggle */}
      <div style={{ position: "absolute", top: "1rem", right: "1rem", display: "flex", gap: "0.375rem" }}>
        <button onClick={() => setLocale("en")} className="btn btn-ghost btn-sm"
          style={{ fontWeight: locale === "en" ? 700 : 400, background: locale === "en" ? "var(--accent-bg)" : undefined, color: locale === "en" ? "var(--accent)" : "var(--text-muted)" }}>EN</button>
        <button onClick={() => setLocale("es")} className="btn btn-ghost btn-sm"
          style={{ fontWeight: locale === "es" ? 700 : 400, background: locale === "es" ? "var(--accent-bg)" : undefined, color: locale === "es" ? "var(--accent)" : "var(--text-muted)" }}>ES</button>
      </div>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <Link href="/">
            <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
          </Link>
          <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.login_title}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
            {t.login_sub}
          </p>
        </div>

        <div className="card p-8">
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {error && (
              <div
                style={{
                  background: "rgba(248,113,113,0.1)",
                  border: "1px solid rgba(248,113,113,0.3)",
                  color: "var(--danger)",
                  borderRadius: "var(--radius)",
                  padding: "0.625rem 0.875rem",
                  fontSize: "0.875rem",
                }}
              >
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>{t.login_email}</label>
              <input
                type="email"
                className="input"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className="flex flex-col gap-2">
              <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>{t.login_password}</label>
              <input
                type="password"
                className="input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-lg"
              disabled={loading}
              style={{ marginTop: "0.5rem" }}
            >
              {loading ? t.login_submitting : t.login_submit}
            </button>
          </form>
        </div>

        <p
          style={{
            textAlign: "center",
            fontSize: "0.875rem",
            color: "var(--text-muted)",
            marginTop: "1.5rem",
          }}
        >
          {t.login_no_account}{" "}
          <Link href="/register" style={{ color: "var(--accent-light)" }}>
            {t.login_register}
          </Link>
        </p>
      </div>
    </div>
  );
}
