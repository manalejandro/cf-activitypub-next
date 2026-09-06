import { type NextRequest } from "next/server";
import { getCloudflareContext, json } from "@/lib/cf";
import { requireAdmin } from "@/lib/admin-auth";
import { getInstanceSetting, setInstanceSetting } from "@/lib/db";

const KEYS = ["rules", "privacy_policy", "terms_of_service", "extended_description", "languages"] as const;
const REGISTRATION_KEYS = ["registrations_enabled", "registrations_approval_required", "registrations_reason_required", "registrations_message", "registrations_min_age", "registrations_url"] as const;

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const settings: Record<string, string | null> = {};
  for (const key of [...KEYS, ...REGISTRATION_KEYS]) {
    settings[key] = await getInstanceSetting(env.DB, key);
  }

  // Parse structured values for the admin form.
  let rules: { id: string; text: string }[] = [];
  try { rules = settings.rules ? JSON.parse(settings.rules) : []; } catch { /* ignore */ }
  let languages: { code: string; name?: string; native_name?: string }[] = [];
  try { languages = settings.languages ? JSON.parse(settings.languages) : []; } catch { /* ignore */ }

  const reg = (key: string, def: boolean): boolean => settings[key] === null ? def : settings[key] === "true";

  return json({
    rules,
    privacy_policy: settings.privacy_policy ?? "",
    terms_of_service: settings.terms_of_service ?? "",
    extended_description: settings.extended_description ?? "",
    languages,
    registrations_enabled: reg("registrations_enabled", true),
    registrations_approval_required: reg("registrations_approval_required", false),
    registrations_reason_required: reg("registrations_reason_required", false),
    registrations_message: settings.registrations_message ?? "",
    registrations_min_age: settings.registrations_min_age ?? "",
    registrations_url: settings.registrations_url ?? "",
  });
}

export async function PUT(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const body = await request.json() as Record<string, unknown>;

  if (body.rules !== undefined) {
    const rules = Array.isArray(body.rules) ? body.rules : [];
    await setInstanceSetting(env.DB, "rules", JSON.stringify(rules));
  }
  if (typeof body.privacy_policy === "string") {
    await setInstanceSetting(env.DB, "privacy_policy", body.privacy_policy);
  }
  if (typeof body.terms_of_service === "string") {
    await setInstanceSetting(env.DB, "terms_of_service", body.terms_of_service);
  }
  if (typeof body.extended_description === "string") {
    await setInstanceSetting(env.DB, "extended_description", body.extended_description);
  }
  if (Array.isArray(body.languages)) {
    await setInstanceSetting(env.DB, "languages", JSON.stringify(body.languages));
  }

  // Registration policy (Mastodon v2 registrations object).
  for (const key of ["registrations_enabled", "registrations_approval_required", "registrations_reason_required"] as const) {
    if (typeof body[key] === "boolean") {
      await setInstanceSetting(env.DB, key, String(body[key]));
    }
  }
  for (const key of ["registrations_message", "registrations_min_age", "registrations_url"] as const) {
    if (typeof body[key] === "string") {
      await setInstanceSetting(env.DB, key, body[key]);
    }
  }

  // Registrations are part of the cached instance payload — invalidate it.
  await Promise.all([
    env.KV.delete("instance:v1").catch(() => {}),
    env.KV.delete("instance:v2").catch(() => {}),
  ]);

  return json({ ok: true });
}