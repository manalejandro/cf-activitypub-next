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
      <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24 }}>
        <h1 style={{ color: "#d32f2f" }}>Invalid authorization request</h1>
        <p>Missing required parameters: <code>response_type=code</code>, <code>client_id</code>, <code>redirect_uri</code>.</p>
      </div>
    );
  }

  let appName = client_id;
  let appWebsite: string | null = null;

  try {
    const { env } = getCloudflareContext();
    const app = await getOAuthAppByClientId(env.DB, client_id);
    if (!app) {
      return (
        <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24 }}>
          <h1 style={{ color: "#d32f2f" }}>Unknown application</h1>
          <p>No application registered with client_id <code>{client_id}</code>.</p>
        </div>
      );
    }
    // Validate redirect_uri matches registered one
    const registeredUris = app.redirectUri.split(/[\n,]/).map((u) => u.trim());
    if (!registeredUris.includes(redirect_uri) && redirect_uri !== "urn:ietf:wg:oauth:2.0:oob") {
      return (
        <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24 }}>
          <h1 style={{ color: "#d32f2f" }}>Redirect URI mismatch</h1>
          <p>The redirect URI does not match what was registered for this application.</p>
        </div>
      );
    }
    appName = app.name;
    appWebsite = app.website;
  } catch {
    // Not in Cloudflare context during build — render the form anyway
  }

  const scopes = scope.split(/\s+/).filter(Boolean);

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "80px auto", padding: 24, border: "1px solid #e0e0e0", borderRadius: 8 }}>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>Authorize application</h1>
      <p style={{ marginBottom: 20, color: "#555" }}>
        <strong>{appName}</strong>
        {appWebsite && <> (<a href={appWebsite} target="_blank" rel="noopener noreferrer">{appWebsite}</a>)</>}
        {" "}is requesting access to your account.
      </p>

      <div style={{ background: "#f5f5f5", borderRadius: 6, padding: "12px 16px", marginBottom: 20 }}>
        <p style={{ margin: "0 0 6px 0", fontWeight: 600, fontSize: 13, color: "#333" }}>Requested permissions:</p>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: "#555" }}>
          {scopes.map((s) => <li key={s}><code>{s}</code></li>)}
        </ul>
      </div>

      <form action="/api/oauth/authorize" method="POST">
        <input type="hidden" name="client_id" value={client_id} />
        <input type="hidden" name="redirect_uri" value={redirect_uri} />
        <input type="hidden" name="scope" value={scope} />
        <input type="hidden" name="state" value={state} />
        {code_challenge && <input type="hidden" name="code_challenge" value={code_challenge} />}
        {code_challenge_method && <input type="hidden" name="code_challenge_method" value={code_challenge_method} />}

        <label style={{ display: "block", marginBottom: 4, fontSize: 13, fontWeight: 600 }}>Email</label>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          style={{ width: "100%", padding: "8px 10px", border: "1px solid #ccc", borderRadius: 4, marginBottom: 12, boxSizing: "border-box" }}
        />

        <label style={{ display: "block", marginBottom: 4, fontSize: 13, fontWeight: 600 }}>Password</label>
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          style={{ width: "100%", padding: "8px 10px", border: "1px solid #ccc", borderRadius: 4, marginBottom: 20, boxSizing: "border-box" }}
        />

        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="submit"
            name="action"
            value="authorize"
            style={{ flex: 1, padding: "10px 0", background: "#6364ff", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontWeight: 600 }}
          >
            Authorize
          </button>
          <button
            type="submit"
            name="action"
            value="deny"
            style={{ flex: 1, padding: "10px 0", background: "#eee", color: "#333", border: "none", borderRadius: 4, cursor: "pointer" }}
          >
            Deny
          </button>
        </div>
      </form>
    </div>
  );
}
