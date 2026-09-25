import type { D1Database } from "@cloudflare/workers-types";
import { getActorById } from "@/lib/db";
import { fetchAndCacheRemoteActor, lastActorFetchStatus } from "@/lib/activitypub/remote";
import { verifySignature } from "@/lib/activitypub/security";

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface ResolvedSignerKey {
  id: string;
  publicKeyPem: string;
}

/**
 * Resolve the public key of the actor that signed an inbox request. The keyId
 * may be a canonical key URI (`https://host/ap/users/1#rsa-…`) on an instance
 * that has migrated the actor URL, so the fetch reuses the same-host canonical
 * re-fetch of `fetchAndCacheRemoteActor` and picks the key matching the keyId
 * when the actor document exposes several (Mastodon 4.6+ key rotation).
 */
export async function resolveSignerKey(
  db: D1Database,
  kv: KVLike | undefined,
  keyId: string,
  options: { forceRefresh?: boolean } = {}
): Promise<ResolvedSignerKey | null> {
  const actorId = keyId.replace(/#.*$/, "");
  if (!actorId.startsWith("https://")) return null;

  const cached = await getActorById(db, actorId);
  if (cached?.publicKeyPem && (!options.forceRefresh || cached.isLocal)) {
    return { id: cached.id, publicKeyPem: cached.publicKeyPem };
  }
  // Never fetch a local actor over the network (a self-fetch would time out).
  if (cached?.isLocal) return null;

  const refreshed = await fetchAndCacheRemoteActor(db, actorId, kv, keyId);
  if (!refreshed) return null;
  if (refreshed.publicKeyPem) return { id: refreshed.id, publicKeyPem: refreshed.publicKeyPem };

  const row = await getActorById(db, refreshed.id);
  return row?.publicKeyPem ? { id: row.id, publicKeyPem: row.publicKeyPem } : null;
}

export type SignatureVerdict = "ok" | "no-key" | "invalid";

/**
 * Actor fetch statuses that mean the key can never be resolved (deleted or
 * malformed actor URL). Anything else (0, 401/403, 429, 5xx) is retryable:
 * a blocked or rate-limited fetch may succeed later.
 */
function isPermanentKeyFailure(status: number): boolean {
  return status === 400 || status === 404 || status === 410 || status === 422;
}

/**
 * Verify an inbox request's HTTP signature, refreshing the signer's key once on
 * failure: Mastodon 4.6+ rotates account keys and a cached key would otherwise
 * reject every delivery until the actor row is refreshed. The refresh is
 * throttled per signer so a broken sender cannot hammer the origin.
 */
export async function verifyIncomingSignature(
  db: D1Database,
  kv: KVLike | undefined,
  params: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
    signingKeyId: string | null;
  }
): Promise<SignatureVerdict> {
  if (!params.signingKeyId) return "invalid";
  const actorId = params.signingKeyId.replace(/#.*$/, "");
  if (!actorId.startsWith("https://")) return "invalid";

  let signer = await resolveSignerKey(db, kv, params.signingKeyId);
  if (!signer) return isPermanentKeyFailure(lastActorFetchStatus(actorId)) ? "invalid" : "no-key";
  if (await verifySignature(params.method, params.url, params.headers, signer.publicKeyPem, params.body)) {
    return "ok";
  }

  const marker = `sig:refresh:${params.signingKeyId}`;
  const recentlyRefreshed = kv ? await kv.get(marker).catch(() => null) : null;
  if (recentlyRefreshed) return "invalid";
  if (kv) await kv.put(marker, "1", { expirationTtl: 300 }).catch(() => {});

  signer = await resolveSignerKey(db, kv, params.signingKeyId, { forceRefresh: true });
  if (!signer) return isPermanentKeyFailure(lastActorFetchStatus(actorId)) ? "invalid" : "no-key";
  return (await verifySignature(params.method, params.url, params.headers, signer.publicKeyPem, params.body))
    ? "ok"
    : "invalid";
}
