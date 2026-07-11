"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
          theme?: "light" | "dark" | "auto";
        }
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface Props {
  turnstileSiteKey: string;
}

export default function LoginForm({ turnstileSiteKey }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState("");
  const { t, locale, setLocale } = useLocale();
  const searchParams = useSearchParams();

  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  // If the script is already loaded (e.g. navigating back from register), init immediately.
  // Also clean up the widget on unmount to avoid "Cannot find Widget" errors.
  useEffect(() => {
    if (typeof window !== "undefined" && window.turnstile) {
      initTurnstile();
    }
    return () => {
      if (window.turnstile && widgetIdRef.current) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read query params for verification feedback
  const verified = searchParams.get("verified") === "true";
  const verifyError = searchParams.get("error");

  function initTurnstile() {
    if (!window.turnstile || !turnstileRef.current || widgetIdRef.current) return;
    widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
      sitekey: turnstileSiteKey,
      callback: (token) => setTurnstileToken(token),
      "expired-callback": () => setTurnstileToken(""),
      "error-callback": () => setTurnstileToken(""),
      theme: "auto",
    });
  }

  function resetTurnstile() {
    if (window.turnstile && widgetIdRef.current) {
      window.turnstile.reset(widgetIdRef.current);
      setTurnstileToken("");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!turnstileToken) {
      setError(t.turnstile_error);
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          username: email,
          password,
          "cf-turnstile-response": turnstileToken,
        }),
      });

      const data = await res.json() as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (!res.ok || !data.access_token) {
        resetTurnstile();
        if (data.error === "unverified_email") {
          setError(t.login_unverified);
        } else {
          setError(data.error_description ?? data.error ?? "Invalid credentials");
        }
        return;
      }

      localStorage.setItem("access_token", data.access_token);
      window.location.href = "/home";
    } catch {
      resetTurnstile();
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
    <>
      {/* Load Turnstile script with explicit render mode */}
      {turnstileSiteKey && (
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          onLoad={initTurnstile}
          strategy="lazyOnload"
        />
      )}

      <div
        className="flex flex-col items-center justify-center min-h-screen px-4"
        style={{ background: "var(--bg)" }}
      >
        {/* Language toggle */}
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
            <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.login_title}</h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
              {t.login_sub}
            </p>
          </div>

          <div className="card p-8">
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {verified && <div style={inlineSuccess}>{t.login_verified_banner}</div>}
              {verifyError === "verify_failed" && <div style={inlineError}>{t.login_verify_error}</div>}
              {verifyError === "verify_expired" && <div style={inlineError}>{t.login_verify_error}</div>}
              {error && <div style={inlineError}>{error}</div>}

              <div className="flex flex-col gap-2">
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.login_email}
                </label>
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
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.login_password}
                </label>
                <input
                  type="password"
                  className="input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  minLength={8}
                />
              </div>

              {/* Cloudflare Turnstile widget */}
              {turnstileSiteKey && (
                <div ref={turnstileRef} style={{ minHeight: "65px" }} />
              )}

              {/* Forgot password link */}
              <div style={{ textAlign: "right", marginTop: "-0.75rem" }}>
                <Link
                  href="/forgot-password"
                  style={{ fontSize: "0.8rem", color: "var(--accent)" }}
                >
                  {t.forgot_password}
                </Link>
              </div>

              {/* Resend verification link */}
              {error === t.login_unverified && (
                <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", margin: 0 }}>
                  <Link
                    href={`/register?resend=${encodeURIComponent(email)}`}
                    style={{ color: "var(--accent)" }}
                  >
                    {t.verify_email_resend}
                  </Link>
                </p>
              )}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || (Boolean(turnstileSiteKey) && !turnstileToken)}
              >
                {loading ? t.login_submitting : t.login_submit}
              </button>
            </form>
          </div>

          <p style={{ textAlign: "center", marginTop: "1.25rem", fontSize: "0.875rem", color: "var(--text-secondary)" }}>
            {t.login_no_account}{" "}
            <Link href="/register" style={{ color: "var(--accent)" }}>
              {t.login_register}
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
