import { type NextRequest } from "next/server";
import { json } from "@/lib/cf";
import { getAdminRole, requireAdmin } from "@/lib/admin-auth";
import { recordModeration } from "@/lib/moderation/log";
import { generateId } from "@/lib/activitypub/utils";
import { getInstanceSetting, setInstanceSetting } from "@/lib/db";
import {
  DEFAULT_EXPIRATION_MONTHS,
  EXPIRATION_ENABLED_KEY,
  EXPIRATION_MONTHS_KEY,
  MAX_EXPIRATION_MONTHS,
  MIN_EXPIRATION_MONTHS,
} from "@/lib/moderation/account-expiration";
import { ANONYMOUS_TIMELINES_KEY, normalizeAnonymousTimelineAccess } from "@/lib/anonymous-timelines";
import { env } from "cloudflare:workers";

const KEYS = ["rules", "privacy_policy", "terms_of_service", "extended_description", "languages"] as const;
const REGISTRATION_KEYS = ["registrations_enabled", "registrations_approval_required", "registrations_reason_required", "registrations_message", "registrations_min_age", "registrations_url"] as const;
/** Account expiration (inactivity): on by default, 12 months. */
const EXPIRATION_KEYS = ["account_expiration_enabled", "account_expiration_months"] as const;
/** Anonymous timeline access (public / public+local / none). */
const TIMELINE_KEYS = [ANONYMOUS_TIMELINES_KEY] as const;

export async function GET(request: NextRequest): Promise<Response> {
  if (!(await requireAdmin(request, env))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const settings: Record<string, string | null> = {};
  for (const key of [...KEYS, ...REGISTRATION_KEYS, ...EXPIRATION_KEYS, ...TIMELINE_KEYS]) {
    settings[key] = await getInstanceSetting(env.DB, key);
  }

  // Parse structured values for the admin form.
  let rules: { id: string; text: string }[] = [];
  try { rules = settings.rules ? JSON.parse(settings.rules) : []; } catch { /* ignore */ }
  let languages: { code: string; name?: string; native_name?: string }[] = [];
  try { languages = settings.languages ? JSON.parse(settings.languages) : []; } catch { /* ignore */ }

  const reg = (key: string, def: boolean): boolean => settings[key] === null ? def : settings[key] === "true";

  // Account expiration: enabled by default, 12 months, clamped to the range the
  // admin form offers (1..120).
  const expirationMonths = Number(settings.account_expiration_months);
  const expiration = {
    enabled: reg("account_expiration_enabled", true),
    months: Number.isFinite(expirationMonths) && expirationMonths >= MIN_EXPIRATION_MONTHS
      ? Math.min(Math.round(expirationMonths), MAX_EXPIRATION_MONTHS)
      : DEFAULT_EXPIRATION_MONTHS,
  };

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
    account_expiration_enabled: expiration.enabled,
    account_expiration_months: expiration.months,
    anonymous_timelines: normalizeAnonymousTimelineAccess(settings.anonymous_timelines),
  });
}

export async function PUT(request: NextRequest): Promise<Response> {
  const role = await getAdminRole(request, env);
  if (role !== "admin") {
    // Authenticated moderators get a 403 (the admin UI shows the section but
    // writes need a full administrator); anonymous callers get 401.
    return json({ error: role ? "Administrator role required" : "Unauthorized" }, role ? 403 : 401);
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

  // Account expiration (inactivity). `months` is clamped to the supported range
  // so a typo can never expire every account at once.
  if (typeof body.account_expiration_enabled === "boolean") {
    await setInstanceSetting(env.DB, EXPIRATION_ENABLED_KEY, String(body.account_expiration_enabled));
  }
  if (body.account_expiration_months !== undefined) {
    const months = Number(body.account_expiration_months);
    if (!Number.isFinite(months) || months < MIN_EXPIRATION_MONTHS || months > MAX_EXPIRATION_MONTHS) {
      return json(
        { error: `account_expiration_months must be between ${MIN_EXPIRATION_MONTHS} and ${MAX_EXPIRATION_MONTHS}` },
        422
      );
    }
    await setInstanceSetting(env.DB, EXPIRATION_MONTHS_KEY, String(Math.round(months)));
  }

  // Anonymous timeline access: normalize so a typo can never widen access.
  if (body.anonymous_timelines !== undefined) {
    await setInstanceSetting(env.DB, ANONYMOUS_TIMELINES_KEY, normalizeAnonymousTimelineAccess(String(body.anonymous_timelines)));
  }

  await recordModeration(env, {
    id: generateId(),
    source: "user",
    targetType: "instance",
    targetId: "instance_settings",
    action: "settings_changed",
    reason: "Instance settings updated by an administrator.",
    confidence: null,
    model: "admin",
    details: { keys: Object.keys(body).slice(0, 30) },
    emailSent: false,
    emailTo: null,
    relatedId: null,
  });

  // Registrations are part of the cached instance payload — invalidate it.
  await Promise.all([
    env.KV.delete("instance:v1").catch(() => {}),
    env.KV.delete("instance:v2").catch(() => {}),
  ]);

  return json({ ok: true });
}