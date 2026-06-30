/**
 * POST /api/v1/calls
 *
 * Initiates a new WebRTC call.  The caller must supply a WebRTC SDP offer,
 * the target account, and the desired media type.
 *
 * For same-instance calls the callee is notified instantly via the
 * Mastodon streaming DO (home channel, event type "call").
 * For cross-instance calls a CallOffer ActivityPub activity is federated to
 * the remote inbox.
 */

import { type NextRequest } from "next/server";
import {
  getCloudflareContext,
  getBaseUrl,
  getDomain,
  json,
  badRequest,
  unauthorized,
} from "@/lib/cf";
import { getAuthenticatedActor } from "@/lib/auth";
import { getActorByUsername, isBlocked } from "@/lib/db";
import { generateId } from "@/lib/activitypub/utils";
import { broadcastCallEvent } from "@/lib/streaming/broadcast";
import { enqueueDeliveries } from "@/lib/activitypub/queue";
import type { CallSession, CallIncomingEvent } from "@/lib/types/call";

const CALL_TTL = 600; // 10 minutes in seconds

export async function POST(request: NextRequest): Promise<Response> {
  const { env } = getCloudflareContext();
  const caller = await getAuthenticatedActor(request, env.DB);
  if (!caller) return unauthorized();

  let body: { target_acct: string; call_type?: "audio" | "video" | "screen"; offer_sdp: string };
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const { target_acct, call_type = "audio", offer_sdp } = body;
  if (!target_acct?.trim()) return badRequest("Missing target_acct");
  if (!offer_sdp?.trim()) return badRequest("Missing offer_sdp");
  if (call_type !== "audio" && call_type !== "video" && call_type !== "screen") return badRequest("Invalid call_type");

  const baseUrl = getBaseUrl(env);
  const localDomain = getDomain(env);

  // ── Resolve target actor ─────────────────────────────────────────────────
  let calleeUsername: string;
  let calleeDomain: string;
  let calleeId: string;
  let calleeAcct: string;

  const atIdx = target_acct.lastIndexOf("@");
  if (atIdx <= 0) {
    // Local actor: "bob"
    calleeUsername = target_acct.toLowerCase();
    calleeDomain = localDomain;
  } else {
    // Could be local or remote: "bob@domain"
    calleeUsername = target_acct.slice(0, atIdx).toLowerCase();
    calleeDomain = target_acct.slice(atIdx + 1).toLowerCase();
  }

  const isLocalCallee = calleeDomain === localDomain;
  const calleeActor = await getActorByUsername(env.DB, calleeUsername, calleeDomain);

  if (!calleeActor) {
    return json({ error: "Target account not found" }, 404);
  }

  calleeId = calleeActor.id;
  calleeAcct = isLocalCallee
    ? calleeActor.username
    : `${calleeActor.username}@${calleeDomain}`;

  const callerAcct = caller.domain === localDomain
    ? caller.username
    : `${caller.username}@${caller.domain}`;

  // ── Block check ──────────────────────────────────────────────────────────
  // Only check for local callees (remote blocks are enforced at the remote instance).
  if (isLocalCallee) {
    const blocked = await isBlocked(env.DB, calleeId, caller.id);
    if (blocked) {
      return json({ error: "call_blocked", message: "This user has blocked you." }, 403);
    }
  }

  // ── Create call session in KV ────────────────────────────────────────────
  const callId = generateId();
  const session: CallSession = {
    id: callId,
    callerId: caller.id,
    calleeId,
    callerAcct,
    calleeAcct,
    callType: call_type,
    offerSdp: offer_sdp,
    answerSdp: null,
    state: "pending",
    createdAt: new Date().toISOString(),
  };

  await env.KV.put(`call:${callId}`, JSON.stringify(session), {
    expirationTtl: CALL_TTL,
  });

  // ── Notify callee ────────────────────────────────────────────────────────
  const incomingEvent: CallIncomingEvent = {
    type: "call.incoming",
    callId,
    callType: call_type,
    callerAcct,
    callerDisplayName: caller.displayName ?? caller.username,
    callerAvatar: caller.avatarUrl ?? null,
    offerSdp: offer_sdp,
  };

  if (isLocalCallee) {
    // Fast path: push directly via streaming DO
    await broadcastCallEvent(env.TIMELINE_STREAM, calleeUsername, incomingEvent);
  } else {
    // Federation path: enqueue CallOffer AP activity for delivery
    const callOffer = buildCallOfferActivity(baseUrl, caller.id, calleeActor, callId, call_type, offer_sdp);
    const inboxUrl = calleeActor.inbox ?? `${calleeId}/inbox`;
    await enqueueDeliveries(
      env.DELIVERY_QUEUE,
      [inboxUrl],
      JSON.stringify(callOffer),
      caller.id
    ).catch(() => {});
  }

  return json({ id: callId, state: "pending" }, 201);
}

// ── ActivityPub helpers ──────────────────────────────────────────────────────

function buildCallOfferActivity(
  baseUrl: string,
  callerId: string,
  calleeActor: { id: string },
  callId: string,
  callType: "audio" | "video" | "screen",
  offerSdp: string
): object {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${baseUrl}/calls/${callId}#offer`,
    type: "CallOffer",
    actor: callerId,
    to: [calleeActor.id],
    object: {
      type: "CallSession",
      id: `${baseUrl}/calls/${callId}`,
      callType,
      sdp: offerSdp,
    },
  };
}
