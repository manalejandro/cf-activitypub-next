import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import { verifyAccountFields } from "@/lib/activitypub/verification";

// POST /api/v1/admin/verify_account — force a rel="me" verification for any
// actor cached on this instance (local or remote). Useful to refresh a remote
// account's badge without waiting for the periodic cron.
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const isAdmin = await requireAdmin(request, env as Parameters<typeof requireAdmin>[1]);
  if (!isAdmin) return unauthorized();

  const body = await request.json().catch(() => ({})) as { id?: string };
  if (!body.id) return json({ error: "id is required" }, 400);

  const { verifiedFields } = await verifyAccountFields(
    env.DB,
    body.id,
    new URL(request.url).hostname
  );
  return json({ ok: true, verifiedFields });
}