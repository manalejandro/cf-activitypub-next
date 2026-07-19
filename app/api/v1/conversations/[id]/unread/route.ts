import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { env } = getCloudflareContext();
  const { id } = await params;
  const me = await getAuthenticatedActor(request, env.DB);
  if (!me) return unauthorized();
  await env.DB
    .prepare("UPDATE conversations SET unread = 1, updated_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
  return json({
    id,
    unread: true,
    last_status: null,
    accounts: [],
  });
}
