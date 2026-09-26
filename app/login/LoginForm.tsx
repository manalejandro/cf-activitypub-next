"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, translateKey } from "@/lib/i18n";
import { useAuth } from "@/lib/client-api";
import { LanguagePicker } from "@/components/LanguagePicker";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          action?: string;
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
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const { t } = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Same-origin redirect target (?redirect=…): after signing in go back to the
  // interaction the visitor came for. Never follow cross-origin targets.
  const rawRedirect = searchParams.get("redirect");
  const redirectTarget = rawRedirect && rawRedirect.startsWith("/") && !rawRedirect.startsWith("//")
    ? rawRedirect
    : "/home";
  // Object/actor URI from /authorize_interaction: forwarded to an external
  // instance so its user can interact from there.
  const interactionUri = searchParams.get("uri");
  // Instance the visitor came from (Referer host): pre-fill and highlight
  // "continue on <instance>" so they can go back to interact there.
  const fromInstance = (() => {
    const raw = searchParams.get("from");
    if (!raw) return "";
    return normalizeInstance(raw) ?? "";
  })();
  // Pre-filled with the instance the visitor came from (React state can't be
  // set from an effect synchronously; derive the initial value instead).
  const [instance, setInstance] = useState(fromInstance);

  // Already signed in? Send them straight to their feed. (Placed after all
  // hooks so the early return never skips a hook call.)
  const { authenticated, loading: authLoading } = useAuth();
  useEffect(() => {
    if (!authLoading && authenticated) router.replace(redirectTarget);
  }, [authLoading, authenticated, router, redirectTarget]);

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
      action: "login",
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
      const res = await fetch("/oauth/token", {
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
        error_code?: string;
      };

      if (!res.ok || !data.access_token) {
        resetTurnstile();
        if (data.error === "unverified_email") {
          setError(translateKey(t, data.error_code, t.login_unverified));
        } else {
          setError(translateKey(t, data.error_code, data.error_description ?? data.error) ?? "Invalid credentials");
        }
        return;
      }

      window.location.href = redirectTarget;
    } catch {
      resetTurnstile();
      setError(t.network_error);
    } finally {
      setLoading(false);
    }
  }

  /** Accepts a domain, a URL or @user@domain and returns the bare host. */
  function normalizeInstance(input: string): string | null {
    let value = input.trim().replace(/^@+/, "");
    if (value.includes("@")) value = value.split("@").pop() ?? "";
    value = value.replace(/^https?:\/\//i, "").split("/")[0].trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) return null;
    return value;
  }

  function handleRemoteLogin(e: React.FormEvent) {
    e.preventDefault();
    const host = normalizeInstance(instance);
    if (!host) {
      setRemoteError(t.login_remote_invalid);
      return;
    }
    setRemoteError(null);
    window.location.href = interactionUri
      ? `https://${host}/authorize_interaction?uri=${encodeURIComponent(interactionUri)}`
      : `https://${host}`;
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

  if (authLoading || authenticated) return null;

  const remoteSection = (
    <>
      <div
        style={{
          display: "flex", alignItems: "center", gap: "0.75rem",
          margin: "1.25rem 0 1rem", color: "var(--text-muted)",
          fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em",
        }}
      >
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
        {t.login_remote_or}
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      </div>

      <form onSubmit={handleRemoteLogin} className="flex flex-col gap-3">
        <label htmlFor="login-remote-instance" style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
          {fromInstance ? t.login_remote_continue.replace("{instance}", fromInstance) : t.login_remote_title}
        </label>
        <div className="flex gap-2">
          <input
            id="login-remote-instance"
            className="input"
            placeholder={t.login_remote_placeholder}
            value={instance}
            onChange={(e) => setInstance(e.target.value)}
            autoComplete="url"
          />
          <button
            type="submit"
            className="btn btn-outline"
            style={{ whiteSpace: "nowrap" }}
          >
            {t.login_remote_button}
          </button>
        </div>
        {remoteError && (
          <p style={{ color: "var(--danger)", fontSize: "0.8rem", margin: 0 }}>{remoteError}</p>
        )}
        <p style={{ color: "var(--text-muted)", fontSize: "0.75rem", margin: 0 }}>
          {t.login_remote_hint}
        </p>
      </form>
    </>
  );

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
        className="force-light flex flex-col items-center justify-center min-h-screen px-4"
        style={{ background: "var(--bg)" }}
      >
        {/* Language selector */}
        <div style={{ position: "absolute", top: "1rem", right: "1rem" }}>
          <LanguagePicker />
        </div>

        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 mb-8">
            <Link href="/">
              <Image src="/logo.svg" alt="" width={52} height={52} />
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

            {Boolean(fromInstance) && remoteSection}
            {!fromInstance && remoteSection}
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
