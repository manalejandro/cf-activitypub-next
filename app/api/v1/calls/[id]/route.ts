/**
 * /api/v1/calls/[id]
 *
 * GET  — retrieve call session details (for the callee to get offer SDP)
 * POST — send a signal: answer SDP, ICE candidates, or hangup
 * DELETE — hang up / reject the call
 */

import { type NextRequest } from "next/server";
import {
  getCloudflareContext,
  getBaseUrl,
  getDomain,
  json,
  badRequest,
  unauthorized,
  notFound,
  checkRateLimit,
} from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorById } from "@/lib/db";
import { broadcastCallEvent } from "@/lib/streaming/broadcast";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { CallSession, CallEventPayload } from "@/lib/types/call";

type RouteParams = { params: Promise<{ id: string }> };

const CALL_TTL = 600;

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const session = await getCallSession(env.KV, id);
  if (!session) return notFound("Call not found");

  // Only caller or callee may view
  if (session.callerId !== actor.id && session.calleeId !== actor.id) {
    return json({ error: "Forbidden" }, 403);
  }

  return json(session);
}

// ── POST — signal ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const session = await getCallSession(env.KV, id);
  if (!session) return notFound("Call not found");

  if (session.callerId !== actor.id && session.calleeId !== actor.id) {
    return json({ error: "Forbidden" }, 403);
  }

  let body: { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON");
  }

  // ── Abuse protection ──────────────────────────────────────────────────────
  const { allowed } = await checkRateLimit(env.KV, `call:signal:${actor.id}:${id}`, 120, 60);
  if (!allowed) {
    return json({ error: "rate_limited", message: "Too many signals." }, 429);
  }

  // Ended sessions only accept idempotent hangup/reject (double-click retries),
  // everything else is rejected so stale clients can't mutate a dead call.
  const callEnded = session.state === "ended" || session.state === "rejected";
  if (callEnded && (body.type === "hangup" || body.type === "reject")) {
    return json({ ok: true });
  }
  if (callEnded) {
    return json({ error: "Call has ended" }, 409);
  }

  const baseUrl = getBaseUrl(env);
  const localDomain = getDomain(env);
  const isCaller = session.callerId === actor.id;

  switch (body.type) {
    case "answer": {
      if (isCaller) return badRequest("Caller cannot send answer");
      if (!body.sdp) return badRequest("Missing sdp");
      if (session.answerSdp) return badRequest("Call already answered");
      session.answerSdp = body.sdp;
      session.state = "active";
      await saveCallSession(env.KV, session);
      // The callee is now busy — block them from starting a parallel call.
      await env.KV.put(`call:active:${session.calleeId}`, id, { expirationTtl: CALL_TTL });

      // Notify caller
      await notifyPeer(env, session, session.callerId, localDomain, {
        type: "call.answered",
        callId: id,
        answerSdp: body.sdp,
      });
      break;
    }

    case "ice": {
      if (!body.candidate) return badRequest("Missing candidate");
      const peerActorId = isCaller ? session.calleeId : session.callerId;

      // Relay ICE candidate via the signaling DO for same-instance calls
      // For cross-instance, federate via ActivityPub
      await notifyPeer(env, session, peerActorId, localDomain, {
        type: "call.ice",
        callId: id,
        candidate: body.candidate,
      });

      // Also push to the CallSignalingDO WebSocket relay for low-latency delivery
      try {
        const doId = env.CALL_SIGNALING.idFromName(id);
        const stub = env.CALL_SIGNALING.get(doId);
        await stub.fetch(`https://call-do/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "ice", candidate: body.candidate }),
        });
      } catch { /* non-critical — WebSocket relay is best-effort */ }
      break;
    }

    case "hangup":
    case "reject": {
      session.state = body.type === "reject" ? "rejected" : "ended";
      await saveCallSession(env.KV, session);
      await clearActiveMarkers(env.KV, session);

      const peerActorId = isCaller ? session.calleeId : session.callerId;
      const eventType = body.type === "reject" ? "call.rejected" : "call.ended";
      await notifyPeer(env, session, peerActorId, localDomain, {
        type: eventType as "call.rejected" | "call.ended",
        callId: id,
      });

      // Also signal via DO WebSocket
      try {
        const doId = env.CALL_SIGNALING.idFromName(id);
        const stub = env.CALL_SIGNALING.get(doId);
        await stub.fetch(`https://call-do/relay`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "hangup" }),
        });
      } catch { /* best-effort */ }
      break;
    }

    // ── Mid-call renegotiation (adding/removing tracks on demand) ──────────
    // Sent via REST so it works for both same-instance (streaming relay) and
    // cross-instance (federated CallRenegotiate / CallRenegotiateAnswer).
    case "renegotiate":
    case "renegotiate-answer": {
      if (!body.sdp) return badRequest("Missing sdp");
      if (session.state !== "active") return badRequest("Call is not active");
      const peerActorId = isCaller ? session.calleeId : session.callerId;
      const eventType = body.type === "renegotiate" ? "call.renegotiate" : "call.renegotiate-answer";
      await notifyPeer(env, session, peerActorId, localDomain, {
        type: eventType as "call.renegotiate" | "call.renegotiate-answer",
        callId: id,
        sdp: body.sdp,
      });
      break;
    }

    default:
      return badRequest("Unknown signal type");
  }

  // Send signal AP activity for cross-instance federation (answer, ice, hangup, reject)
  const peerActorId = isCaller ? session.calleeId : session.callerId;
  const isPeerRemote = !peerActorId.startsWith(baseUrl);
  if (isPeerRemote) {
    const peerActor = await getActorById(env.DB, peerActorId);
    if (peerActor?.inbox) {
      const apActivity = buildSignalActivity(baseUrl, actor.id, peerActorId, id, body);
      await enqueueDeliveries(
        env.DELIVERY_QUEUE,
        [peerActor.inbox],
        JSON.stringify(apActivity),
        actor.id,
        `${actor.id}#main-key`,
        actor.privateKeyPem
      ).catch(() => {});
    }
  }

  return json({ ok: true });
}

// ── DELETE — hang up ──────────────────────────────────────────────────────────

export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { env } = getCloudflareContext();
  const actor = await getAuthenticatedActor(request, env.DB);
  if (!actor) return unauthorized();

  const { id } = await params;
  const session = await getCallSession(env.KV, id);
  if (!session) return notFound("Call not found");
  if (session.callerId !== actor.id && session.calleeId !== actor.id) {
    return json({ error: "Forbidden" }, 403);
  }

  // Idempotent: a repeated hangup (double-click) must not re-notify peers.
  if (session.state === "ended" || session.state === "rejected") {
    return new Response(null, { status: 204 });
  }

  session.state = "ended";
  await saveCallSession(env.KV, session);
  await clearActiveMarkers(env.KV, session);

  const baseUrl = getBaseUrl(env);
  const localDomain = getDomain(env);
  const peerActorId = session.callerId === actor.id ? session.calleeId : session.callerId;
  await notifyPeer(env, session, peerActorId, localDomain, { type: "call.ended", callId: id });

  // Cross-instance federation for hangup via DELETE
  const isPeerRemote = !peerActorId.startsWith(baseUrl);
  if (isPeerRemote) {
    const peerActor = await getActorById(env.DB, peerActorId);
    if (peerActor?.inbox) {
      const apActivity = buildSignalActivity(baseUrl, actor.id, peerActorId, id, { type: "hangup" });
      await enqueueDeliveries(
        env.DELIVERY_QUEUE,
        [peerActor.inbox],
        JSON.stringify(apActivity),
        actor.id,
        `${actor.id}#main-key`,
        actor.privateKeyPem
      ).catch(() => {});
    }
  }

  try {
    const doId = env.CALL_SIGNALING.idFromName(id);
    const stub = env.CALL_SIGNALING.get(doId);
    await stub.fetch(`https://call-do/relay`, {
      method: "POST",
      body: JSON.stringify({ type: "hangup" }),
      headers: { "Content-Type": "application/json" },
    });
  } catch { /* best-effort */ }

  return new Response(null, { status: 204 });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type KVNamespace = { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DONamespaceAny = { idFromName(name: string): any; get(id: any): { fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> } };

interface MinimalEnv {
  KV: KVNamespace;
  TIMELINE_STREAM: DONamespaceAny;
  CALL_SIGNALING: DONamespaceAny;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DELIVERY_QUEUE: any;
  DB: D1Database;
}

async function getCallSession(kv: KVNamespace, id: string): Promise<CallSession | null> {
  const raw = await kv.get(`call:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as CallSession; } catch { return null; }
}

async function saveCallSession(kv: KVNamespace, session: CallSession): Promise<void> {
  await kv.put(`call:${session.id}`, JSON.stringify(session), { expirationTtl: CALL_TTL });
}

/** Drop the "active call" markers so the peers can start new calls. */
async function clearActiveMarkers(kv: KVNamespace, session: CallSession): Promise<void> {
  await kv.delete(`call:active:${session.callerId}`).catch(() => {});
  await kv.delete(`call:active:${session.calleeId}`).catch(() => {});
}

async function notifyPeer(
  env: MinimalEnv,
  session: CallSession,
  peerActorId: string,
  localDomain: string,
  event: CallEventPayload
): Promise<void> {
  // Determine if peer is local
  const isLocal = !peerActorId.includes(".") || peerActorId.includes(`//${localDomain}/`);
  if (!isLocal) return; // Cross-instance handled separately via AP

  const username = peerActorId === session.callerId
    ? session.callerAcct.split("@")[0]
    : session.calleeAcct.split("@")[0];

  try {
    await broadcastCallEvent(env.TIMELINE_STREAM, username, event);
  } catch {
    // skip
  }
}

function buildSignalActivity(
  baseUrl: string,
  actorId: string,
  toActorId: string,
  callId: string,
  signal: { type: string; sdp?: string; candidate?: RTCIceCandidateInit }
): object {
  const typeMap: Record<string, string> = {
    answer: "CallAnswer",
    ice: "CallIceCandidate",
    hangup: "CallHangup",
    renegotiate: "CallRenegotiate",
    "renegotiate-answer": "CallRenegotiateAnswer",
  };
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${baseUrl}/calls/${callId}#${signal.type}-${Date.now()}`,
    type: typeMap[signal.type] ?? "CallSignal",
    actor: actorId,
    to: [toActorId],
    object: {
      type: "CallSession",
      id: `${baseUrl}/calls/${callId}`,
      ...(signal.sdp ? { sdp: signal.sdp } : {}),
      ...(signal.candidate ? { candidate: JSON.stringify(signal.candidate) } : {}),
    },
  };
}
