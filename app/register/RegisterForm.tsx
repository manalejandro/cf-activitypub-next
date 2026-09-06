"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import Script from "next/script";
import { useSearchParams } from "next/navigation";
import { useLocale } from "@/lib/i18n";
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

interface RegSettings {
  enabled: boolean;
  approvalRequired: boolean;
  reasonRequired: boolean;
  message: string | null;
  minAge: number | null;
  url: string | null;
}

export default function RegisterForm({ turnstileSiteKey }: Props) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [reason, setReason] = useState("");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [regs, setRegs] = useState<RegSettings | null>(null);
  const { t } = useLocale();
  const searchParams = useSearchParams();

  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  // If the script is already loaded (e.g. navigating from login), init immediately.
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

  // Support pre-filling email for resend flow from /register?resend=email
  const resendEmail = searchParams.get("resend");

  useEffect(() => {
    if (resendEmail) {
      Promise.resolve().then(() => {
        setPendingEmail(decodeURIComponent(resendEmail));
      });
    }
  }, [resendEmail]);

  // Load the instance registration policy (Mastodon v2 registrations object).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v2/instance")
      .then((r): Promise<{ registrations?: { enabled: boolean; approval_required?: boolean; reason_required?: boolean; message: string | null; min_age?: number | null; url?: string | null } } | null> => (r.ok ? r.json() : Promise.resolve(null)))
      .then((data) => {
        if (!cancelled && data?.registrations) {
          setRegs({
            enabled: data.registrations.enabled !== false,
            approvalRequired: data.registrations.approval_required === true,
            reasonRequired: data.registrations.reason_required === true,
            message: data.registrations.message ?? null,
            minAge: data.registrations.min_age ?? null,
            url: data.registrations.url ?? null,
          });
        }
      })
      .catch(() => { /* keep defaults (open registration) */ });
    return () => { cancelled = true; };
  }, []);

  function initTurnstile() {
    if (!window.turnstile || !turnstileRef.current || widgetIdRef.current) return;
    widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
      sitekey: turnstileSiteKey,
      action: "register",
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
    if (password !== confirmPassword) {
      setError(t.register_password_mismatch);
      setLoading(false);
      return;
    }
    if (regs?.minAge && !ageConfirmed) {
      setError(t.register_age_required.replace("{age}", String(regs.minAge)));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          email,
          password,
          reason: reason.trim() || undefined,
          age_confirmed: regs?.minAge ? "true" : undefined,
          "cf-turnstile-response": turnstileToken,
        }),
      });

      const data = await res.json() as {
        pending_verification?: boolean;
        pending_approval?: boolean;
        access_token?: string;
        error?: string;
      };

      if (!res.ok) {
        resetTurnstile();
        setError(data.error ?? "Registration failed");
        return;
      }

      if (data.pending_approval) {
        // Approval-required instance: account created, waiting for an admin.
        setPendingApproval(true);
        return;
      }

      if (data.pending_verification) {
        // Show "check your email" screen
        setPendingEmail(email);
        return;
      }

      if (data.access_token) {
        window.location.href = "/home";
      }
    } catch {
      resetTurnstile();
      setError(t.network_error);
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (!pendingEmail) return;
    setResendLoading(true);
    setResendSent(false);

    try {
      await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingEmail }),
      });
      setResendSent(true);
    } catch {
      // silently ignore
    } finally {
      setResendLoading(false);
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

  // ── "Pending approval" screen ─────────────────────────────────────────────
  if (pendingApproval) {
    return (
      <div
        className="force-light flex flex-col items-center justify-center min-h-screen px-4"
        style={{ background: "var(--bg)" }}
      >
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 mb-8">
            <Link href="/">
              <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
            </Link>
            <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.register_pending_title}</h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0, textAlign: "center" }}>
              {t.register_pending_sub}
            </p>
          </div>
          <div className="card p-8" style={{ textAlign: "center" }}>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: "0 0 1rem" }}>
              {t.register_pending_body}
            </p>
            <Link
              href="/login"
              style={{ color: "var(--accent)", fontSize: "0.875rem" }}
            >
              {t.register_signin}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── "Check your email" screen ──────────────────────────────────────────────
  if (pendingEmail) {
    return (
      <div
        className="force-light flex flex-col items-center justify-center min-h-screen px-4"
        style={{ background: "var(--bg)" }}
      >
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 mb-8">
            <Link href="/">
              <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
            </Link>
            <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.verify_email_title}</h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0, textAlign: "center" }}>
              {t.verify_email_sub}{" "}
              <strong style={{ color: "var(--text)" }}>{pendingEmail}</strong>
            </p>
          </div>

          <div className="card p-8 flex flex-col gap-5 items-center">
            <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
              <circle cx="28" cy="28" r="28" fill="var(--accent-bg, rgba(139,92,246,0.1))" />
              <path d="M14 21l14 9 14-9" stroke="var(--accent, #8b5cf6)" strokeWidth="2" strokeLinecap="round" />
              <rect x="14" y="18" width="28" height="20" rx="3" stroke="var(--accent, #8b5cf6)" strokeWidth="2" fill="none" />
            </svg>

            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", textAlign: "center", margin: 0 }}>
              Click the link in the email to activate your account. The link expires in 24 hours.
            </p>

            {resendSent ? (
              <div style={inlineSuccess}>{t.verify_email_resent}</div>
            ) : (
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleResend}
                disabled={resendLoading}
                style={{ color: "var(--accent)" }}
              >
                {resendLoading ? t.verify_email_resending : t.verify_email_resend}
              </button>
            )}

            <Link
              href="/login"
              style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}
            >
              {t.register_signin}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Registration closed / external URL ─────────────────────────────────────
  if (regs && (!regs.enabled || regs.url)) {
    return (
      <div
        className="force-light flex flex-col items-center justify-center min-h-screen px-4"
        style={{ background: "var(--bg)" }}
      >
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center gap-3 mb-8">
            <Link href="/">
              <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
            </Link>
            <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.register_title}</h1>
          </div>
          <div className="card p-8" style={{ textAlign: "center" }}>
            {regs.enabled && regs.url ? (
              <>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: "0 0 1rem" }}>
                  {t.register_external}
                </p>
                <a className="btn btn-primary" href={regs.url} target="_blank" rel="noreferrer">
                  {t.register_external_btn}
                </a>
              </>
            ) : (
              <>
                <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
                  {t.register_closed}
                </p>
              </>
            )}
          </div>
          <p style={{ textAlign: "center", marginTop: "1.25rem", fontSize: "0.875rem", color: "var(--text-secondary)" }}>
            {t.register_have_account}{" "}
            <Link href="/login" style={{ color: "var(--accent)" }}>
              {t.register_signin}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  // ── Registration form ──────────────────────────────────────────────────────
  return (
    <>
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
              <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
            </Link>
            <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.register_title}</h1>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
              {t.register_sub}
            </p>
          </div>

          <div className="card p-8">
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {error && <div style={inlineError}>{error}</div>}

              {regs?.message && (
                <div
                  style={{
                    background: "rgba(139,92,246,0.08)",
                    border: "1px solid rgba(139,92,246,0.25)",
                    color: "var(--text-secondary)",
                    borderRadius: "var(--radius)",
                    padding: "0.625rem 0.875rem",
                    fontSize: "0.85rem",
                  }}
                >
                  {regs.message}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.register_username}
                </label>
                <input
                  type="text"
                  className="input"
                  placeholder="yourname"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  pattern="[a-zA-Z0-9_]{1,30}"
                  title={t.register_username_hint}
                  required
                  autoComplete="username"
                />
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  {t.register_username_hint}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                  {t.register_email}
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

              {regs?.reasonRequired && (
                <div className="flex flex-col gap-2">
                  <label style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
                    {t.register_reason}
                  </label>
                  <textarea
                    className="input"
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    required
                    placeholder={t.register_reason_ph}
                  />
                </div>
              )}

              {regs?.minAge ? (
                <label style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.875rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={ageConfirmed}
                    onChange={(e) => setAgeConfirmed(e.target.checked)}
                    style={{ marginTop: "0.2rem" }}
                  />
                  {t.register_age_confirm.replace("{age}", String(regs.minAge))}
                </label>
              ) : null}

              {/* Cloudflare Turnstile widget */}
              {turnstileSiteKey && (
                <div ref={turnstileRef} style={{ minHeight: "65px" }} />
              )}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || (Boolean(turnstileSiteKey) && !turnstileToken)}
              >
                {loading ? t.register_submitting : t.register_submit}
              </button>

              {regs?.approvalRequired && (
                <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: 0, textAlign: "center" }}>
                  {t.register_approval_note}
                </p>
              )}
            </form>
          </div>

          <p style={{ textAlign: "center", marginTop: "1.25rem", fontSize: "0.875rem", color: "var(--text-secondary)" }}>
            {t.register_have_account}{" "}
            <Link href="/login" style={{ color: "var(--accent)" }}>
              {t.register_signin}
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
