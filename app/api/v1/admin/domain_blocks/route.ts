import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import {
  getInstanceDomainBlocks,
  createInstanceDomainBlock,
  deleteInstanceDomainBlock,
} from "@/lib/db";

// GET /api/v1/admin/domain_blocks — list instance-wide domain blocks.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const blocks = await getInstanceDomainBlocks(env.DB);
  return json(
    blocks.map((b) => ({
      domain: b.domain,
      severity: b.severity,
      reject_media: b.rejectMedia,
      reject_reports: b.rejectReports,
      private_comment: b.privateComment,
      public_comment: b.publicComment,
      obfuscate: b.obfuscate,
      created_at: b.createdAt,
    }))
  );
}

// POST /api/v1/admin/domain_blocks — block a domain instance-wide.
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await request.json() as Record<string, unknown>;
  const domain = typeof body.domain === "string" ? body.domain.trim().toLowerCase() : "";
  if (!domain) return badRequest("domain is required");

  await createInstanceDomainBlock(env.DB, {
    domain,
    severity: body.severity === "silence" ? "silence" : "suspend",
    rejectMedia: body.reject_media !== false,
    rejectReports: body.reject_reports !== false,
    privateComment: typeof body.private_comment === "string" ? body.private_comment : null,
    publicComment: typeof body.public_comment === "string" ? body.public_comment : null,
    obfuscate: body.obfuscate === true,
    createdAt: new Date().toISOString(),
  });

  return json({ ok: true });
}

// DELETE /api/v1/admin/domain_blocks?domain=… — remove an instance-wide block.
export async function DELETE(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const domain = request.nextUrl.searchParams.get("domain")?.trim().toLowerCase();
  if (!domain) return badRequest("domain is required");

  await deleteInstanceDomainBlock(env.DB, domain);
  return json({ ok: true });
}
