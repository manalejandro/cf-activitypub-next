import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getMarkers, upsertMarker } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";

export async function GET(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const timelines = request.nextUrl.searchParams.getAll("timeline[]");
  if (timelines.length === 0) return json({});

  const markers = await getMarkers(env.DB, actor.id, timelines);

  const result: Record<string, { last_read_id: string; version: number; updated_at: string }> = {};
  for (const m of markers) {
    result[m.timeline] = {
      last_read_id: m.lastReadId,
      version: m.version,
      updated_at: m.updatedAt,
    };
  }

  return json(result);
}

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const contentType = request.headers.get("Content-Type") ?? "";
  let body: Record<string, string | undefined> = {};

  if (contentType.includes("application/json")) {
    const parsed = await request.json() as Record<string, Record<string, string>>;
    for (const [key, val] of Object.entries(parsed)) {
      if (key === "home" || key === "notifications") {
        body[key] = val.last_read_id;
      }
    }
  } else {
    const form = await request.formData();
    for (const [key, val] of form.entries()) {
      body[key] = val.toString();
    }
  }

  const homeLastRead = body["home[last_read_id]"] ?? (body as Record<string, string>)["home"] ?? undefined;
  const notifLastRead = body["notifications[last_read_id]"] ?? (body as Record<string, string>)["notifications"] ?? undefined;

  const result: Record<string, { last_read_id: string; version: number; updated_at: string }> = {};

  if (homeLastRead) {
    const marker = await upsertMarker(env.DB, generateId(), actor.id, "home", homeLastRead, 0);
    if (!marker.success) {
      return json({ error: "Conflict during update, please try again" }, 409);
    }
    result.home = {
      last_read_id: homeLastRead,
      version: marker.newVersion,
      updated_at: new Date().toISOString(),
    };
  }

  if (notifLastRead) {
    const marker = await upsertMarker(env.DB, generateId(), actor.id, "notifications", notifLastRead, 0);
    if (!marker.success) {
      return json({ error: "Conflict during update, please try again" }, 409);
    }
    result.notifications = {
      last_read_id: notifLastRead,
      version: marker.newVersion,
      updated_at: new Date().toISOString(),
    };
  }

  return json(result);
}
