import type { D1Database } from "@cloudflare/workers-types";
import { deleteRemoteActorData, getActorById } from "@/lib/db";
import { fetchAndCacheRemoteActor, lastActorFetchStatus } from "@/lib/activitypub/remote";
import { verifySignature } from "@/lib/activitypub/security";

interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface SignerKeySuccess {
  ok: true;
  id: string;
  publicKeyPem: string;
}

export interface SignerKeyFailure {
  ok: false;
  /** True when the key will never be resolvable (deleted/gone/malformed actor). */
  permanent: boolean;
  /** HTTP status of the actor fetch (0 = network error / blocked). */
  status: number;
}

export type SignerKeyResult = SignerKeySuccess | SignerKeyFailure;

/**
 * Actor fetch statuses that mean the key can never be resolved (deleted or
 * malformed actor URL, or the origin refuses to serve it). Anything else
 * (0, 401, 429, 5xx) is retryable: a blocked or rate-limited fetch may succeed
 * later.
 */
function isPermanentKeyFailure(status: number): boolean {
  // 301/308: the actor's host permanently redirects to another domain (the
  // old identity is gone; the new account has its own key).
  return status === 301 || status === 308 || status === 400 || status === 403 || status === 404 || status === 410 || status === 422;
}

function keyFailMarker(actorId: string): string {
  return `sig:keyfail:${actorId}`;
}

/**
 * Resolve the public key of the actor that signed an inbox request. The keyId
 * may be a canonical key URI (`https://host/ap/users/1#rsa-…`) on an instance
 * that has migrated the actor URL, so the fetch reuses the same-host canonical
 * re-fetch of `fetchAndCacheRemoteActor` and picks the key matching the keyId
 * when the actor document exposes several (Mastodon 4.6+ key rotation).
 *
 * Failures are negatively cached (KV) so a sender whose key is gone or
 * unreachable cannot trigger a fetch per delivery.
 */
export async function resolveSignerKey(
  db: D1Database,
  kv: KVLike | undefined,
  keyId: string,
  options: { forceRefresh?: boolean } = {}
): Promise<SignerKeyResult> {
  const actorId = keyId.replace(/#.*$/, "");
  if (!actorId.startsWith("https://")) return { ok: false, permanent: true, status: 0 };

  const cached = await getActorById(db, actorId);
  if (cached?.publicKeyPem && (!options.forceRefresh || cached.isLocal)) {
    return { ok: true, id: cached.id, publicKeyPem: cached.publicKeyPem };
  }
  // Never fetch a local actor over the network (a self-fetch would time out).
  if (cached?.isLocal) return { ok: false, permanent: true, status: 0 };

  if (!options.forceRefresh) {
    const marker = kv ? await kv.get(keyFailMarker(actorId)).catch(() => null) : null;
    if (marker !== null) {
      const status = Number(marker);
      return { ok: false, permanent: isPermanentKeyFailure(status), status };
    }
  }

  const refreshed = await fetchAndCacheRemoteActor(db, actorId, kv, keyId);
  if (!refreshed) {
    const status = lastActorFetchStatus(actorId);
    const permanent = isPermanentKeyFailure(status);
    if (kv) {
      await kv
        .put(keyFailMarker(actorId), String(status), { expirationTtl: permanent ? 86400 : 300 })
        .catch(() => {});
    }
    return { ok: false, permanent, status };
  }
  if (kv?.delete) await kv.delete(keyFailMarker(actorId)).catch(() => {});

  if (refreshed.publicKeyPem) return { ok: true, id: refreshed.id, publicKeyPem: refreshed.publicKeyPem };
  const row = await getActorById(db, refreshed.id);
  if (row?.publicKeyPem) return { ok: true, id: row.id, publicKeyPem: row.publicKeyPem };
  return { ok: false, permanent: true, status: 0 };
}

/**
 * An activity whose signer key the origin reports as 410 Gone cannot be
 * verified any more, but the origin is stating the account does not exist: purge
 * our cached copy (actor, posts, notifications and follows cascade) so deleted
 * accounts do not linger. Only an explicit 410 triggers this — never a 403/404
 * that may be a temporary block or a fetch problem. Returns true when a cached
 * copy was purged.
 */
export async function purgeGoneSignerData(
  db: D1Database,
  check: SignatureCheck,
  signingActorId: string
): Promise<boolean> {
  if (check.reason !== "gone") return false;
  const status = check.status ?? 0;
  // 410: the origin declares the actor Gone. 301/308: the actor's host moved to
  // another domain, so the old identity (and its cached copy) is dead.
  if (status !== 410 && status !== 301 && status !== 308) return false;
  const cached = await getActorById(db, signingActorId);
  if (!cached || cached.isLocal) return false;
  await deleteRemoteActorData(db, signingActorId).catch(() => {});
  return true;
}

export interface SignatureCheck {
  ok: boolean;
  /**
   * `gone`: the key is permanently unavailable (deleted/suspended account);
   * `no-key`: the key could not be fetched right now (retryable);
   * `invalid`: a key was available and the signature does not match.
   */
  reason: "ok" | "gone" | "no-key" | "invalid";
  status?: number;
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
): Promise<SignatureCheck> {
  if (!params.signingKeyId) return { ok: false, reason: "invalid" };
  const actorId = params.signingKeyId.replace(/#.*$/, "");
  if (!actorId.startsWith("https://")) return { ok: false, reason: "invalid" };

  const failure = (result: SignerKeyFailure): SignatureCheck =>
    result.permanent
      ? { ok: false, reason: "gone", status: result.status }
      : { ok: false, reason: "no-key", status: result.status };

  let signer = await resolveSignerKey(db, kv, params.signingKeyId);
  if (!signer.ok) return failure(signer);
  if (await verifySignature(params.method, params.url, params.headers, signer.publicKeyPem, params.body)) {
    return { ok: true, reason: "ok" };
  }

  const marker = `sig:refresh:${params.signingKeyId}`;
  const recentlyRefreshed = kv ? await kv.get(marker).catch(() => null) : null;
  if (recentlyRefreshed) return { ok: false, reason: "invalid" };
  if (kv) await kv.put(marker, "1", { expirationTtl: 300 }).catch(() => {});

  signer = await resolveSignerKey(db, kv, params.signingKeyId, { forceRefresh: true });
  if (!signer.ok) return failure(signer);
  return (await verifySignature(params.method, params.url, params.headers, signer.publicKeyPem, params.body))
    ? { ok: true, reason: "ok" }
    : { ok: false, reason: "invalid" };
}
