import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getDomainBlocks, createDomainBlock, deleteDomainBlock } from "@/lib/db";
import { getAuthenticatedActor } from "@/lib/auth";
import { generateId } from "@/lib/activitypub/utils";

// GET /api/v1/domain_blocks
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const domains = await getDomainBlocks(env.DB, actor.id);
  return json(domains);
}

// POST /api/v1/domain_blocks  (body: { domain: string })
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const body = await request.json() as { domain?: string };
  const domain = body.domain?.trim().toLowerCase();
  if (!domain) return json({ error: "domain is required" }, 422);

  await createDomainBlock(env.DB, generateId(), actor.id, domain);
  return json({}, 200);
}

// DELETE /api/v1/domain_blocks  (body or query: { domain: string })
export async function DELETE(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const url = new URL(request.url);
  let domain = url.searchParams.get("domain")?.trim().toLowerCase();
  if (!domain) {
    try {
      const body = await request.json() as { domain?: string };
      domain = body.domain?.trim().toLowerCase();
    } catch { /* no body */ }
  }
  if (!domain) return json({ error: "domain is required" }, 422);

  await deleteDomainBlock(env.DB, actor.id, domain);
  return json({}, 200);
}
