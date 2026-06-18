import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";

// GET /.well-known/oauth-authorization-server  (RFC 8414)
// OAuth 2.0 Authorization Server Metadata — required by Mastodon 4.3.0+
export async function GET(request: NextRequest): Promise<Response> {
  const { origin } = new URL(request.url);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: ["read", "write", "follow", "push", "admin:read", "admin:write"],
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment"],
    grant_types_supported: ["authorization_code", "client_credentials", "password"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: `${origin}/api/v2/instance`,
  });
}
