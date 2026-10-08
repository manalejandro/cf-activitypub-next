import { type NextRequest } from "next/server";
import { json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { env } from "cloudflare:workers";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const rawId = decodeURIComponent(id);
  const me = await getAuthenticatedActor(_request, env.DB);
  if (!me) return unauthorized();
  return json({ id: rawId, email: null });
}
