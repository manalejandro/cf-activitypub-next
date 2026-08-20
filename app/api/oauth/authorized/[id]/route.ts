import { type NextRequest } from "next/server";
import { getCloudflareContext, json, notFound, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor, extractBearerToken, clearAuthCookie } from "@/lib/auth";
import { getOAuthTokenById, deleteOAuthToken } from "@/lib/db";

// DELETE /api/oauth/authorized/:id — revoke one of the authenticated user's
// app connections or web sessions. Revoking the current session logs it out.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const tokenRow = await getOAuthTokenById(env.DB, id);
  if (!tokenRow || tokenRow.actorId !== actor.id) {
    return notFound("Connection not found");
  }

  const currentToken = extractBearerToken(request) ?? "";
  const revokedCurrent = tokenRow.accessToken === currentToken;

  await deleteOAuthToken(env.DB, id);

  return json(
    { revokedCurrent },
    200,
    revokedCurrent ? { "Set-Cookie": clearAuthCookie() } : {}
  );
}