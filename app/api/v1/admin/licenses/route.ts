import { type NextRequest } from "next/server";
import { getCloudflareContext, json, badRequest } from "@/lib/cf";
import { getAdminRole, requireAdmin } from "@/lib/admin-auth";
import { createLicense, deleteLicense, getLicenseById, getLicenseByUrl, listLicenses, updateLicense } from "@/lib/db";
import { normalizeLicenseId, normalizeLicenseUrl } from "@/lib/licenses";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import type { D1Database } from "@cloudflare/workers-types";

/** Audit every catalogue change in the moderation log. */
async function logLicense(
  env: { DB: D1Database },
  action: string,
  targetId: string,
  reason: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "license",
    targetId,
    action,
    reason,
    confidence: null,
    model: "admin",
    details,
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });
}

// GET /api/v1/admin/licenses — full catalogue (FEP-6757) for the admin screen.
export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }
  const licenses = await listLicenses(env.DB);
  return json({ licenses, total: licenses.length });
}

// POST /api/v1/admin/licenses — add, edit or remove a catalogue entry.
// body: { action: "add" | "update" | "delete", id?, name?, url?, icon?, sort_order? }
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Invalid JSON body");
  }
  const action = typeof body.action === "string" ? body.action : "add";

  if (action === "add") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const url = normalizeLicenseUrl(typeof body.url === "string" ? body.url : "");
    if (!name || !url) return badRequest("name and an https license URL are required");
    const id = normalizeLicenseId(typeof body.id === "string" && body.id.trim() ? body.id : name);
    if (!id) return badRequest("Could not derive an id from the name");
    if (await getLicenseById(env.DB, id)) return badRequest("That id is already in use");
    if (await getLicenseByUrl(env.DB, url)) return badRequest("That license is already in the catalogue");
    const sortOrder = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 100;
    await createLicense(env.DB, {
      id,
      name: name.slice(0, 120),
      url,
      icon: typeof body.icon === "string" ? body.icon.trim().slice(0, 80) : "",
      sortOrder,
      createdAt: new Date().toISOString(),
    });
    await logLicense(env, "license_added", id, "License added to the catalogue by an administrator.", { url });
    return json({ ok: true, license: await getLicenseById(env.DB, id) });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const license = id ? await getLicenseById(env.DB, id) : null;
  if (!license) return json({ error: "License not found" }, 404);

  if (action === "delete") {
    // Statuses keep their `license_url` (no FK), so removing a catalogue entry
    // only takes it out of the selectors.
    await deleteLicense(env.DB, id);
    await logLicense(env, "license_removed", id, "License removed from the catalogue by an administrator.", { url: license.url });
    return json({ ok: true });
  }

  if (action === "update") {
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    const url = body.url === undefined ? undefined : normalizeLicenseUrl(typeof body.url === "string" ? body.url : "");
    if (url === null) return badRequest("The license URL must be a public https URL");
    if (url && url !== license.url && (await getLicenseByUrl(env.DB, url))) {
      return badRequest("Another catalogue entry already uses that URL");
    }
    await updateLicense(env.DB, id, {
      name: name ? name.slice(0, 120) : undefined,
      url: url ?? undefined,
      icon: typeof body.icon === "string" ? body.icon.trim().slice(0, 80) : undefined,
      sortOrder: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : undefined,
    });
    await logLicense(env, "license_updated", id, "License updated by an administrator.");
    return json({ ok: true, license: await getLicenseById(env.DB, id) });
  }

  return badRequest("Unknown action");
}
