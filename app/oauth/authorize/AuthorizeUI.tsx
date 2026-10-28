"use client";

import Image from "next/image";
import { useLocale, translateKey } from "@/lib/i18n";
import TurnstileFormWidget from "@/components/TurnstileFormWidget";

/** What the server page decided to render (data fetched/validated server-side). */
export type AuthorizeView =
  | { kind: "invalid-params" }
  | { kind: "error"; titleKey: string; bodyKey: string; clientId?: string }
  | {
      kind: "consent";
      appName: string;
      appWebsite: string | null;
      scopes: string[];
      clientId: string;
      redirectUri: string;
      scope: string;
      state: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
    };

/**
 * The OAuth consent screen. A client component so every string goes through the
 * locale dictionary (the page itself stays a server component: it reads the
 * binding, validates the request and resolves the registered app).
 */
export function AuthorizeUI({ view, siteKey }: { view: AuthorizeView; siteKey: string }) {
  const { t } = useLocale();

  if (view.kind === "invalid-params") {
    return (
      <Centered>
        <div className="card p-8 flex flex-col gap-3">
          <h1 style={{ color: "var(--danger)", fontSize: "1.5rem", margin: 0 }}>{t.oauth_invalid_request}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
            {t.oauth_invalid_request_body}
          </p>
        </div>
      </Centered>
    );
  }

  if (view.kind === "error") {
    const title = translateKey(t, view.titleKey) ?? view.titleKey;
    const body = (translateKey(t, view.bodyKey) ?? view.bodyKey).replace("{client_id}", view.clientId ?? "");
    return (
      <Centered>
        <div className="card p-8 flex flex-col gap-3">
          <h1 style={{ color: "var(--danger)", fontSize: "1.5rem", margin: 0 }}>{title}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>{body}</p>
        </div>
      </Centered>
    );
  }

  return (
    <Centered>
      <div className="flex flex-col items-center gap-3 mb-8">
        <Image src="/logo.svg" alt="" width={52} height={52} unoptimized />
        <h1 style={{ fontSize: "1.6rem", margin: 0 }}>{t.oauth_authorize_title}</h1>
      </div>

      <div className="card p-8 flex flex-col gap-5" style={{ width: "100%" }}>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", margin: 0, lineHeight: 1.5 }}>
          <strong style={{ color: "var(--text-primary)" }}>{view.appName}</strong>
          {view.appWebsite && <> (<a href={view.appWebsite} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{view.appWebsite}</a>)</>}
          {" "}{t.oauth_consent_requesting}
        </p>

        <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem 1rem" }}>
          <p style={{ margin: "0 0 0.375rem 0", fontWeight: 600, fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {t.oauth_requested_permissions}
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
            {view.scopes.map((s) => (
              <span key={s} style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", borderRadius: "var(--radius)", background: "var(--accent-bg)", color: "var(--accent)", fontWeight: 500 }}>
                {s}
              </span>
            ))}
          </div>
        </div>

        <form action="/api/oauth/authorize" method="POST" className="flex flex-col gap-5">
          <input type="hidden" name="client_id" value={view.clientId} />
          <input type="hidden" name="redirect_uri" value={view.redirectUri} />
          <input type="hidden" name="scope" value={view.scope} />
          <input type="hidden" name="state" value={view.state} />
          {view.codeChallenge && <input type="hidden" name="code_challenge" value={view.codeChallenge} />}
          {view.codeChallengeMethod && <input type="hidden" name="code_challenge_method" value={view.codeChallengeMethod} />}

          <div className="flex flex-col gap-2">
            <label htmlFor="oauth-email" style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
              {t.login_email}
            </label>
            <input
              id="oauth-email"
              type="email"
              name="email"
              required
              autoComplete="email"
              className="input"
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="oauth-password" style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
              {t.login_password}
            </label>
            <input
              id="oauth-password"
              type="password"
              name="password"
              required
              autoComplete="current-password"
              className="input"
              placeholder="••••••••"
            />
          </div>

          {/* The consent form verifies passwords: with Turnstile configured the
              instance requires the same challenge as the web login. */}
          <TurnstileFormWidget siteKey={siteKey} action="login" />

          <div style={{ display: "flex", gap: "0.625rem" }}>
            <button
              type="submit"
              name="action"
              value="authorize"
              className="btn btn-primary"
              style={{ flex: 1 }}
            >
              {t.oauth_authorize}
            </button>
            <button
              type="submit"
              name="action"
              value="deny"
              className="btn btn-outline"
              style={{ flex: 1 }}
            >
              {t.oauth_deny}
            </button>
          </div>
        </form>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col items-center justify-center min-h-screen px-4"
      style={{ background: "var(--bg)" }}
    >
      <div style={{ width: "100%", maxWidth: 440 }}>{children}</div>
    </div>
  );
}
