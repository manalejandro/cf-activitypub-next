import { type NextRequest } from "next/server";
import { env } from "cloudflare:workers";
import { safeFetch } from "@/lib/activitypub/federation";
import { discardBody } from "@/lib/http";
import { MEDIA_CORS_HEADERS } from "@/lib/media/serve";
import { atomicRateLimit } from "@/lib/rate-limit";

/**
 * Same-origin relay for remote audio attachments.
 *
 * The audio waveform is a live spectrum read through Web Audio, and the spec
 * silences a media element routed into it when the resource is cross-origin
 * without CORS (`MediaElementAudioSourceNode`): a remote attachment whose media
 * cache entry expired points at its origin, and its waveform stayed frozen
 * (measured against cf-ap: analyser max 124 on the cached copy, 0 on the
 * origin URL). This streams the origin through the Worker instead — same origin
 * for the element, nothing stored — forwarding `Range`/`If-Range` so seeking
 * keeps working.
 *
 * Deliberately narrow: only `audio` attachments of statuses we already store
 * (indexed probe on `attachments.remote_url`) are relayed, so the endpoint is
 * not an open proxy. Anything else answers 404 and the player falls back to the
 * origin URL — playback keeps working with the static waveform, exactly the
 * previous behaviour. The outbound timeout is disabled on purpose: a podcast
 * episode legitimately streams for longer than the 10 s guard every other
 * caller uses.
 */
export async function GET(request: NextRequest): Promise<Response> {
  // Every relayed request opens an unbounded outbound stream: cap how often
  // one IP can start new relays (a listener plays one episode at a time; this
  // only stops scripted flooding).
  const relayIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { allowed: canRelay } = await atomicRateLimit(env, `audio-relay:${relayIp}`, 60, 60);
  if (!canRelay) {
    return new Response("Too many requests", { status: 429, headers: { ...MEDIA_CORS_HEADERS } });
  }

  const raw = request.nextUrl.searchParams.get("url");
  if (!raw || !/^https:\/\//i.test(raw)) {
    return new Response("Bad request", { status: 400, headers: { ...MEDIA_CORS_HEADERS } });
  }

  const known = await env.DB
    .prepare(
      "SELECT 1 AS ok FROM attachments WHERE remote_url = ? AND (type = 'audio' OR mime_type LIKE 'audio/%') LIMIT 1"
    )
    .bind(raw)
    .first<{ ok: number }>();
  if (!known?.ok) return new Response("Not found", { status: 404, headers: { ...MEDIA_CORS_HEADERS } });

  // Only what a media element actually needs: cookies and conditional headers
  // are not forwarded (the origin must not see the viewer's session, and a 304
  // would leave the player empty-handed).
  const forwarded = new Headers();
  for (const name of ["range", "if-range", "accept", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  const upstream = await safeFetch(raw, { headers: forwarded }, 0);
  const relayable = upstream && (upstream.ok || upstream.status === 416);
  if (!relayable) {
    // Never leave the upstream body unread: an origin that answers 5xx with an
    // open body would pin an in-flight fetch slot indefinitely (the relay runs
    // with the outbound timeout disabled).
    await discardBody(upstream);
    return new Response("Upstream unavailable", { status: 502, headers: { ...MEDIA_CORS_HEADERS } });
  }

  const headers = new Headers({ ...MEDIA_CORS_HEADERS });
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Browser cache only: the copy belongs to whoever played it.
  headers.set("Cache-Control", "private, max-age=600");
  return new Response(upstream.body, { status: upstream.status, headers });
}
