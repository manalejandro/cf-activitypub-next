import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest } from "@/lib/cf";
import { getAdminRole, requireAdmin } from "@/lib/admin-auth";
import {
  getInstanceDomainBlocks,
  createInstanceDomainBlock,
  deleteInstanceDomainBlock,
} from "@/lib/db";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { normalizeDomain } from "@/lib/activitypub/instances";

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

  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    // Authenticated moderators get a 403 (the admin UI shows the section but
    // writes need a full administrator); anonymous callers get 401.
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }

  const body = await request.json() as Record<string, unknown>;
  const domain = normalizeDomain(typeof body.domain === "string" ? body.domain : null);
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

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "domain",
    targetId: domain,
    action: "blocked",
    reason: `Domain blocked by an administrator (${body.severity === "silence" ? "silence" : "suspend"}).`,
    confidence: null,
    model: "admin",
    details: { severity: body.severity === "silence" ? "silence" : "suspend" },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  return json({ ok: true });
}

// DELETE /api/v1/admin/domain_blocks?domain=… — remove an instance-wide block.
export async function DELETE(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    // Authenticated moderators get a 403 (the admin UI shows the section but
    // writes need a full administrator); anonymous callers get 401.
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }

  const domain = normalizeDomain(request.nextUrl.searchParams.get("domain"));
  if (!domain) return badRequest("domain is required");

  await deleteInstanceDomainBlock(env.DB, domain);
  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "domain",
    targetId: domain,
    action: "unblocked",
    reason: "Domain unblocked by an administrator.",
    confidence: null,
    model: "admin",
    details: {},
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });
  return json({ ok: true });
}
