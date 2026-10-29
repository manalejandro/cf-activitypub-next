import { getOAuthAppByClientId } from "@/lib/db";
import { env } from "cloudflare:workers";
import { AuthorizeUI, type AuthorizeView } from "./AuthorizeUI";

interface Props {
  searchParams: Promise<Record<string, string>>;
}

// The UI lives in `AuthorizeUI` (client) so every string is translated; this
// page keeps what only the server can do: read the binding, validate the
// request and resolve the registered application.
export default async function OAuthAuthorizePage({ searchParams }: Props) {
  const params = await searchParams;
  const { client_id, redirect_uri, scope = "read", state = "", response_type, code_challenge, code_challenge_method } = params;

  // Validate required params
  if (response_type !== "code" || !client_id || !redirect_uri) {
    return <AuthorizeUI view={{ kind: "invalid-params" }} />;
  }

  let appName = client_id;
  let appWebsite: string | null = null;
  let error: { titleKey: string; bodyKey: string; clientId?: string } | null = null;

  try {
    const app = await getOAuthAppByClientId(env.DB, client_id);
    if (!app) {
      error = { titleKey: "oauth_unknown_app", bodyKey: "oauth_unknown_app_body", clientId: client_id };
    } else {
      // Validate redirect_uri matches registered one
      const registeredUris = app.redirectUri.split(/[\n,]/).map((u) => u.trim());
      if (!registeredUris.includes(redirect_uri) && redirect_uri !== "urn:ietf:wg:oauth:2.0:oob") {
        error = { titleKey: "oauth_redirect_mismatch", bodyKey: "oauth_redirect_mismatch_body" };
      } else {
        appName = app.name;
        appWebsite = app.website;
      }
    }
  } catch {
    // Not in Cloudflare context during build — render the form anyway
  }

  if (error) {
    return <AuthorizeUI view={{ kind: "error", ...error }} />;
  }

  const view: AuthorizeView = {
    kind: "consent",
    appName,
    appWebsite,
    scopes: scope.split(/\s+/).filter(Boolean),
    clientId: client_id,
    redirectUri: redirect_uri,
    scope,
    state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
  };
  return <AuthorizeUI view={view} />;
}
