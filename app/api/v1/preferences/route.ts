import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized, badRequest } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";

const DEFAULT_PREFERENCES: Record<string, string | null> = {
  "posting:default:visibility": "public",
  "posting:default:sensitive": "false",
  "posting:default:language": "en",
  "posting:default:quote_policy": "followers",
  "reading:expand:media": "default",
  "reading:expand:spoilers": "false",
};

const PREFERENCE_KEYS = new Set(Object.keys(DEFAULT_PREFERENCES));

const VISIBILITIES = new Set(["public", "unlisted", "followers", "direct"]);
const QUOTE_POLICIES = new Set(["public", "followers", "followed", "nobody"]);
const MEDIA_EXPANSIONS = new Set(["default", "show_all", "hide_all"]);

// Validates and coerces a preference value into its storage (string) form.
function normalizeValue(key: string, raw: unknown): string | null | undefined {
  if (key === "posting:default:sensitive" || key === "reading:expand:spoilers") {
    return typeof raw === "boolean" ? String(raw) : undefined;
  }
  if (key === "posting:default:language") {
    if (raw === null) return null;
    if (typeof raw === "string" && /^[a-z]{2}$/.test(raw)) return raw;
    return undefined;
  }
  if (typeof raw !== "string") return undefined;
  switch (key) {
    case "posting:default:visibility":
      return VISIBILITIES.has(raw) ? raw : undefined;
    case "posting:default:quote_policy":
      return QUOTE_POLICIES.has(raw) ? raw : undefined;
    case "reading:expand:media":
      return MEDIA_EXPANSIONS.has(raw) ? raw : undefined;
    default:
      return undefined;
  }
}

// Converts stored string values into the JSON shape the API returns.
function toApiValue(key: string, stored: string | null): string | boolean | null {
  if (key === "posting:default:sensitive" || key === "reading:expand:spoilers") {
    return stored === "true";
  }
  return stored;
}

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const rows = await env.DB
    .prepare("SELECT key, value FROM preferences WHERE actor_id = ?")
    .bind(actor.id)
    .all<{ key: string; value: string }>();

  const stored = new Map(rows.results?.map((r) => [r.key, r.value]) ?? []);
  const prefs: Record<string, string | boolean | null> = {};
  for (const key of PREFERENCE_KEYS) {
    prefs[key] = toApiValue(key, stored.has(key) ? stored.get(key)! : DEFAULT_PREFERENCES[key]);
  }
  return json(prefs);
}

export async function PUT(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const updates: { key: string; value: string | null }[] = [];
  for (const [key, raw] of Object.entries(body)) {
    if (!PREFERENCE_KEYS.has(key)) continue;
    const value = normalizeValue(key, raw);
    if (value === undefined) return badRequest(`Invalid value for "${key}"`);
    updates.push({ key, value });
  }

  if (updates.length > 0) {
    await env.DB.batch(updates.map((u) =>
      env.DB
        .prepare(
          "INSERT INTO preferences (actor_id, key, value) VALUES (?, ?, ?) ON CONFLICT (actor_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
        )
        .bind(actor.id, u.key, u.value)
    ));
  }

  const rows = await env.DB
    .prepare("SELECT key, value FROM preferences WHERE actor_id = ?")
    .bind(actor.id)
    .all<{ key: string; value: string }>();

  const stored = new Map(rows.results?.map((r) => [r.key, r.value]) ?? []);
  const prefs: Record<string, string | boolean | null> = {};
  for (const key of PREFERENCE_KEYS) {
    prefs[key] = toApiValue(key, stored.has(key) ? stored.get(key)! : DEFAULT_PREFERENCES[key]);
  }
  return json(prefs);
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return PUT(request);
}