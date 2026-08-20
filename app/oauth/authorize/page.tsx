import Image from "next/image";
import { getCloudflareContext } from "@/lib/cf";
import { getOAuthAppByClientId } from "@/lib/db";

interface Props {
  searchParams: Promise<Record<string, string>>;
}

export default async function OAuthAuthorizePage({ searchParams }: Props) {
  const params = await searchParams;
  const { client_id, redirect_uri, scope = "read", state = "", response_type, code_challenge, code_challenge_method } = params;

  // Validate required params
  if (response_type !== "code" || !client_id || !redirect_uri) {
    return (
      <Centered>
        <div className="card p-8 flex flex-col gap-3">
          <h1 style={{ color: "var(--danger)", fontSize: "1.5rem", margin: 0 }}>Invalid authorization request</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
            Missing required parameters: <code>response_type=code</code>, <code>client_id</code>, <code>redirect_uri</code>.
          </p>
        </div>
      </Centered>
    );
  }

  let appName = client_id;
  let appWebsite: string | null = null;
  let errorTitle: string | null = null;
  let errorBody: string | null = null;

  try {
    const { env } = getCloudflareContext();
    const app = await getOAuthAppByClientId(env.DB, client_id);
    if (!app) {
      errorTitle = "Unknown application";
      errorBody = `No application registered with client_id ${client_id}.`;
    } else {
      // Validate redirect_uri matches registered one
      const registeredUris = app.redirectUri.split(/[\n,]/).map((u) => u.trim());
      if (!registeredUris.includes(redirect_uri) && redirect_uri !== "urn:ietf:wg:oauth:2.0:oob") {
        errorTitle = "Redirect URI mismatch";
        errorBody = "The redirect URI does not match what was registered for this application.";
      } else {
        appName = app.name;
        appWebsite = app.website;
      }
    }
  } catch {
    // Not in Cloudflare context during build — render the form anyway
  }

  if (errorTitle) {
    return (
      <Centered>
        <div className="card p-8 flex flex-col gap-3">
          <h1 style={{ color: "var(--danger)", fontSize: "1.5rem", margin: 0 }}>{errorTitle}</h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>{errorBody}</p>
        </div>
      </Centered>
    );
  }

  const scopes = scope.split(/\s+/).filter(Boolean);

  return (
    <Centered>
      <div className="flex flex-col items-center gap-3 mb-8">
        <Image src="/logo.svg" alt="CF ActivityPub" width={52} height={52} />
        <h1 style={{ fontSize: "1.6rem", margin: 0 }}>Authorize application</h1>
      </div>

      <div className="card p-8 flex flex-col gap-5" style={{ width: "100%" }}>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.95rem", margin: 0, lineHeight: 1.5 }}>
          <strong style={{ color: "var(--text-primary)" }}>{appName}</strong>
          {appWebsite && <> (<a href={appWebsite} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{appWebsite}</a>)</>}
          {" "}is requesting access to your account.
        </p>

        <div style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.875rem 1rem" }}>
          <p style={{ margin: "0 0 0.375rem 0", fontWeight: 600, fontSize: "0.8rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Requested permissions
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
            {scopes.map((s) => (
              <span key={s} style={{ fontSize: "0.72rem", padding: "0.2rem 0.5rem", borderRadius: "var(--radius)", background: "var(--accent-bg)", color: "var(--accent)", fontWeight: 500 }}>
                {s}
              </span>
            ))}
          </div>
        </div>

        <form action="/api/oauth/authorize" method="POST" className="flex flex-col gap-5">
          <input type="hidden" name="client_id" value={client_id} />
          <input type="hidden" name="redirect_uri" value={redirect_uri} />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="state" value={state} />
          {code_challenge && <input type="hidden" name="code_challenge" value={code_challenge} />}
          {code_challenge_method && <input type="hidden" name="code_challenge_method" value={code_challenge_method} />}

          <div className="flex flex-col gap-2">
            <label htmlFor="oauth-email" style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}>
              Email
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
              Password
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

          <div style={{ display: "flex", gap: "0.625rem" }}>
            <button
              type="submit"
              name="action"
              value="authorize"
              className="btn btn-primary"
              style={{ flex: 1 }}
            >
              Authorize
            </button>
            <button
              type="submit"
              name="action"
              value="deny"
              className="btn btn-outline"
              style={{ flex: 1 }}
            >
              Deny
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