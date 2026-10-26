import { type NextRequest } from "next/server";
import { json, unauthorized, checkRateLimit } from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { verifyMoveTarget, performMove } from "@/lib/activitypub/migration";
import { env } from "cloudflare:workers";

// POST /api/v1/accounts/migrate — migrate this account to another instance.
// Body: { target_acct: "user@remote.example" }
export async function POST(request: NextRequest): Promise<Response> {
  const domain = new URL(request.url).hostname;
  const baseUrl = `https://${domain}`;

  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();
  if (!actor.privateKeyPem) return json({ error: "Account has no private key" }, 500);
  if (actor.movedTo) return json({ error: "Account has already moved elsewhere" }, 422);

  // A migration re-follows every local follower from this account and fans a
  // Move out to every remote one: a handful of attempts per hour is plenty.
  const { allowed: canMigrate } = await checkRateLimit(env.KV, `migrate:${actor.id}`, 3, 3600);
  if (!canMigrate) return json({ error: "Too many migration attempts. Please try again later." }, 429);

  const body = await request.json() as { target_acct?: string };
  const targetAcct = (body.target_acct ?? "").replace(/^@/, "").trim();
  if (!targetAcct) return json({ error: "target_acct is required" }, 422);

  const verification = await verifyMoveTarget(env.DB, actor.id, targetAcct);
  if (!verification.ok || !verification.target) {
    return json({ error: verification.error ?? "Verification failed" }, 422);
  }

  const { migratedLocal, delivered } = await performMove(
    env.DB,
    baseUrl,
    actor,
    verification.target,
    env.DELIVERY_QUEUE,
    env.KV
  );

  return json({
    moved_to: verification.target.id,
    migrated_followers: migratedLocal,
    delivered_to: delivered,
  });
}