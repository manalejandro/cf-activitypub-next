/**
 * Call session data stored in Workers KV.
 * Key: call:{uuid}  — TTL 600 s (10 min)
 */
export interface CallSession {
  id: string;
  callerId: string;      // AP actor IRI
  calleeId: string;      // AP actor IRI (or acct for remote actors)
  callerAcct: string;    // "alice" (local) or "alice@remote" (cross-instance)
  calleeAcct: string;
  callType: "audio" | "video" | "screen";
  offerSdp: string;
  answerSdp: string | null;
  state: "pending" | "active" | "ended" | "rejected";
  createdAt: string;     // ISO-8601
}

/** WebRTC signal message exchanged via the CallSignalingDO WebSocket. */
export interface CallSignal {
  type: "offer" | "answer" | "ice" | "hangup";
  callId?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  reason?: string;
}

/** Event payload sent to the callee's home streaming channel. */
export interface CallIncomingEvent {
  type: "call.incoming";
  callId: string;
  callType: "audio" | "video" | "screen";
  callerAcct: string;
  callerDisplayName: string;
  callerAvatar: string | null;
  offerSdp: string;
}

export type CallEventPayload =
  | CallIncomingEvent
  | { type: "call.answered"; callId: string; answerSdp: string }
  | { type: "call.rejected"; callId: string }
  | { type: "call.ended"; callId: string }
  | { type: "call.ice"; callId: string; candidate: RTCIceCandidateInit };
