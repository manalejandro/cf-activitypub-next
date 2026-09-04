import { type NextRequest } from "next/server";
import { getCloudflareContext, json, unauthorized } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById, getFollow, createFollow } from "@/lib/db";
import { buildFollow, generateId } from "@/lib/activitypub/utils";
import { resolveWebFinger, deliverToInbox } from "@/lib/activitypub/federation";
import { fetchAndCacheRemoteActor } from "@/lib/activitypub/remote";

// POST /api/v1/import/follows — Mastodon-compatible CSV import
// Accepts "Account address[,Show boosts]" rows (one per line, optional header).
// Resolves every handle via WebFinger, follows the remote account, and returns
// a per-handle report.
export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();
  if (!actor.privateKeyPem) return json({ error: "Account has no private key" }, 500);

  const body = await request.text();
  const handles = parseFollowingCsv(body);
  if (handles.length === 0) {
    return json({ error: "No valid account addresses found in CSV" }, 422);
  }

  const results: { acct: string; status: "followed" | "already_following" | "not_found" | "error"; error?: string }[] = [];

  for (const handle of handles) {
    try {
      const acct = handle.replace(/^@/, "").trim();
      if (!acct.includes("@")) {
        results.push({ acct: handle, status: "error", error: "Invalid handle (expected user@domain)" });
        continue;
      }

      const resolvedUrl = await resolveWebFinger(acct);
      if (!resolvedUrl) {
        results.push({ acct: handle, status: "not_found" });
        continue;
      }

      let target = await getActorById(env.DB, resolvedUrl);
      if (!target) {
        const cached = await fetchAndCacheRemoteActor(env.DB, resolvedUrl, env.KV);
        if (!cached) {
          results.push({ acct: handle, status: "not_found" });
          continue;
        }
        target = await getActorById(env.DB, cached.id);
      }
      if (!target) {
        results.push({ acct: handle, status: "not_found" });
        continue;
      }

      if (actor.id === target.id) {
        results.push({ acct: handle, status: "error", error: "Cannot follow yourself" });
        continue;
      }

      const existing = await getFollow(env.DB, actor.id, target.id);
      if (existing) {
        results.push({ acct: handle, status: "already_following" });
        continue;
      }

      const followId = generateId();
      const followActivity = buildFollow(baseUrl, actor.id, target.id, followId);

      await createFollow(env.DB, {
        id: followId,
        actorId: actor.id,
        targetId: target.id,
        state: target.manuallyApprovesFollowers ? "pending" : "accepted",
        activityId: followActivity.id,
        createdAt: new Date().toISOString(),
      });

      if (target.isLocal) {
        if (!target.manuallyApprovesFollowers) {
          await env.DB.prepare("UPDATE actors SET following_count = COALESCE(following_count, 0) + 1 WHERE id = ?").bind(actor.id).run();
          await env.DB.prepare("UPDATE actors SET followers_count = COALESCE(followers_count, 0) + 1 WHERE id = ?").bind(target.id).run();
        }
      } else {
        const inboxUrl = target.inbox ?? `${target.id}/inbox`;
        try {
          await deliverToInbox(
            inboxUrl,
            followActivity,
            `${actor.id}#main-key`,
            actor.privateKeyPem
          );
        } catch {
          // Delivery failure is non-fatal — follow is saved locally.
        }
        if (!target.manuallyApprovesFollowers) {
          await env.DB.prepare("UPDATE actors SET following_count = COALESCE(following_count, 0) + 1 WHERE id = ?").bind(actor.id).run();
        }
      }

      results.push({ acct: handle, status: "followed" });
    } catch (err) {
      results.push({ acct: handle, status: "error", error: String(err) });
    }
  }

  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return json({ results, counts, total: handles.length });
}

/** Parse a Mastodon following-list CSV into an array of handles. */
function parseFollowingCsv(body: string): string[] {
  const handles: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = splitCsvLine(line);
    if (fields.length === 0) continue;
    const first = fields[0].trim();
    // Skip a header row like "Account address" or "Account address,Show boosts"
    if (first.toLowerCase() === "account address") continue;
    if (first) handles.push(first);
  }
  return handles;
}

/** Minimal RFC-4180 splitter (quotes, embedded commas). */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}