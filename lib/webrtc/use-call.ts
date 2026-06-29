/**
 * useCall — React hook that manages the full WebRTC calling lifecycle.
 *
 * Responsibilities:
 *   - Listens for incoming call events on the Mastodon streaming WebSocket
 *   - Manages RTCPeerConnection setup, media acquisition, and ICE gathering
 *   - Sends signals (offer, answer, ICE, hangup) to the REST API
 *   - Exposes state for the UI layer (CallOverlay)
 *
 * Usage:
 *   const call = useCall(streamingEvents);
 *   // streamingEvents is the onEvent callback from useTimelineStream("user", ...)
 */

"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { CallIncomingEvent, CallEventPayload } from "@/lib/types/call";

type RTCIceServerConfig = { urls: string | string[]; username?: string; credential?: string };

export type CallState =
  | { phase: "idle" }
  | { phase: "incoming"; event: CallIncomingEvent }
  | { phase: "calling"; callId: string; callType: "audio" | "video" | "screen"; targetAcct: string }
  | { phase: "active"; callId: string; callType: "audio" | "video" | "screen"; peerAcct: string }
  | { phase: "blocked"; targetAcct: string }
  | { phase: "ended"; reason?: string };

export interface UseCallReturn {
  callState: CallState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** Call a remote account. Returns the call ID or null on failure. */
  startCall: (targetAcct: string, callType: "audio" | "video" | "screen") => Promise<string | null>;
  /** Accept an incoming call. */
  acceptCall: () => Promise<void>;
  /** Decline an incoming call or hang up an active call. */
  endCall: () => Promise<void>;
  /** Toggle local audio mute. Acquires mic on first unmute. */
  toggleMute: () => Promise<void>;
  /** Toggle local video. Acquires camera on first enable. */
  toggleVideo: () => Promise<void>;
  /** Toggle screen sharing (replaces video track with display capture). */
  toggleScreenShare: () => Promise<void>;
  isMuted: boolean;
  isVideoOff: boolean;
  isSharingScreen: boolean;
  /** The active screen capture stream (non-null while sharing). Used by the UI for PiP. */
  screenStream: MediaStream | null;
  /** Handler to be wired up to the streaming event callback. */
  handleStreamingEvent: (event: string, payload: string) => void;
}

const API_BASE = "/api/v1/calls";

async function getIceServers(accessToken?: string | null): Promise<RTCIceServerConfig[]> {
  try {
    const res = await fetch(`${API_BASE}/ice-servers`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    if (res.ok) {
      const data = await res.json() as { iceServers: RTCIceServerConfig[] };
      return data.iceServers ?? [];
    }
  } catch { /* ignore */ }
  return [];
}

export function useCall(accessToken?: string | null): UseCallReturn {
  const [callState, setCallState] = useState<CallState>({ phase: "idle" });
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // Start muted/camera-off; user enables media on demand
  const [isMuted, setIsMuted] = useState(true);
  const [isVideoOff, setIsVideoOff] = useState(true);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  /** Acquired mic stream (getUserMedia audio). Null until user unmutes. */
  const micStreamRef = useRef<MediaStream | null>(null);
  /** Acquired camera stream (getUserMedia video). Null until user enables camera. */
  const camStreamRef = useRef<MediaStream | null>(null);
  /** Prevents concurrent onnegotiationneeded renegotiations. */
  const isNegotiatingRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const callIdRef = useRef<string | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescSetRef = useRef(false);
  /** Timer that fires when the peer connection has been "disconnected" too long. */
  const disconnectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (disconnectedTimerRef.current) {
      clearTimeout(disconnectedTimerRef.current);
      disconnectedTimerRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (camStreamRef.current) {
      camStreamRef.current.getTracks().forEach((t) => t.stop());
      camStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setIsMuted(true);
    setIsVideoOff(true);
    setIsSharingScreen(false);
    setScreenStream(null);
    isNegotiatingRef.current = false;
    callIdRef.current = null;
    pendingCandidatesRef.current = [];
    remoteDescSetRef.current = false;
  }, [localStream]);

  // ── Connect to CallSignalingDO WebSocket ──────────────────────────────────
  const connectSignalingWs = useCallback((callId: string) => {
    if (wsRef.current) wsRef.current.close();
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/v1/calls/${callId}/ws${
      accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : ""
    }`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (ev) => {
      let msg: { type: string; sdp?: string; candidate?: RTCIceCandidateInit; reason?: string };
      try { msg = JSON.parse(ev.data as string); } catch { return; }

      const pc = pcRef.current;
      if (!pc) return;

      switch (msg.type) {
        case "answer":
          if (msg.sdp) {
            pc.setRemoteDescription({ type: "answer", sdp: msg.sdp })
              .then(() => {
                remoteDescSetRef.current = true;
                for (const c of pendingCandidatesRef.current) {
                  pc.addIceCandidate(c).catch(() => {});
                }
                pendingCandidatesRef.current = [];
              })
              .catch((e) => console.error("[call] setRemoteDescription(answer) error:", e));
          }
          break;
        case "ice":
          if (msg.candidate) {
            if (remoteDescSetRef.current) {
              pc.addIceCandidate(msg.candidate).catch(() => {});
            } else {
              pendingCandidatesRef.current.push(msg.candidate);
            }
          }
          break;
        // ── Mid-call renegotiation (triggered when either peer adds/removes tracks) ──
        case "renegotiate":
          if (msg.sdp) {
            pc.setRemoteDescription({ type: "offer", sdp: msg.sdp })
              .then(async () => {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ type: "renegotiate-answer", sdp: answer.sdp }));
              })
              .catch((e) => console.error("[call] renegotiate error:", e));
          }
          break;
        case "renegotiate-answer":
          if (msg.sdp) {
            pc.setRemoteDescription({ type: "answer", sdp: msg.sdp })
              .then(() => { isNegotiatingRef.current = false; })
              .catch((e) => console.error("[call] renegotiate-answer error:", e));
          }
          break;
        case "hangup":
          setCallState({ phase: "ended", reason: msg.reason });
          cleanup();
          setTimeout(() => setCallState({ phase: "idle" }), 3000);
          break;
      }
    };

    ws.onerror = (e) => console.error("[call] signaling WebSocket error:", e);
  }, [accessToken, cleanup]);

  // ── Acquire and attach initial media (called from startCall / acceptCall) ─
  // Tries to get the appropriate media based on call type and adds the tracks
  // to the peer connection. Runs in the user-gesture context (button click),
  // so getUserMedia / getDisplayMedia are allowed.
  // When `calleeMode` is true (callee accepting a screen call) only audio is
  // acquired, since the callee receives the caller's screen — not their own.
  const acquireAndAttachInitialMedia = useCallback(async (
    pc: RTCPeerConnection,
    callType: "audio" | "video" | "screen",
    calleeMode: boolean = false,
  ): Promise<void> => {
    try {
      if (callType === "screen" && !calleeMode) {
        // Caller-side screen share
        const displayStream = await (navigator.mediaDevices as MediaDevices & {
          getDisplayMedia(c?: MediaStreamConstraints): Promise<MediaStream>;
        }).getDisplayMedia({ video: true, audio: false });
        screenStreamRef.current = displayStream;
        const videoTrack = displayStream.getVideoTracks()[0];
        pc.addTrack(videoTrack, displayStream);
        videoTrack.onended = () => {
          setIsSharingScreen(false);
          setScreenStream(null);
          screenStreamRef.current = null;
        };
        setScreenStream(displayStream);
        setIsSharingScreen(true);
        setIsVideoOff(false);
        // Also grab mic for audio in the call
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micStreamRef.current = micStream;
          const audioTrack = micStream.getAudioTracks()[0];
          pc.addTrack(audioTrack, micStream);
          const micTrack = micStream.getAudioTracks()[0];
          setLocalStream(new MediaStream([videoTrack, ...(micTrack ? [micTrack] : [])]));
          setIsMuted(false);
        } catch {
          setLocalStream(new MediaStream([videoTrack]));
        }
      } else if (callType === "video") {
        // Camera + mic
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        const [audioTrack] = stream.getAudioTracks();
        const [videoTrack] = stream.getVideoTracks();
        if (audioTrack) {
          micStreamRef.current = new MediaStream([audioTrack]);
          pc.addTrack(audioTrack, stream);
          setIsMuted(false);
        }
        if (videoTrack) {
          camStreamRef.current = new MediaStream([videoTrack]);
          pc.addTrack(videoTrack, stream);
          setIsVideoOff(false);
        }
        setLocalStream(stream);
      } else {
        // Audio call (or callee side of a screen share call — just mic)
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStreamRef.current = stream;
        const [audioTrack] = stream.getAudioTracks();
        pc.addTrack(audioTrack, stream);
        setLocalStream(stream);
        setIsMuted(false);
      }
    } catch (err) {
      console.warn("[call] acquireInitialMedia failed (continuing without local media):", err);
      // Non-fatal: call proceeds with recvonly; remote can still send media
    }
  }, []);

  // ── Build RTCPeerConnection ───────────────────────────────────────────────
  // Media is NOT acquired here. Transceivers establish the offer/answer
  // capability; actual tracks are added via acquireAndAttachInitialMedia.
  const createPeerConnection = useCallback(async (callType: "audio" | "video" | "screen"): Promise<RTCPeerConnection> => {
    const iceServers = await getIceServers(accessToken);
    const pc = new RTCPeerConnection({ iceServers });
    pcRef.current = pc;

    // Pre-negotiate media sections so the remote knows what to expect.
    // Direction starts as recvonly; sending starts when user enables mic/camera.
    pc.addTransceiver("audio", { direction: "recvonly" });
    if (callType !== "audio") {
      pc.addTransceiver("video", { direction: "recvonly" });
    }

    const remoteMs = new MediaStream();
    setRemoteStream(remoteMs);

    pc.ontrack = (ev) => {
      // Use ev.track directly — ev.streams may be empty when the sender
      // associates each track with a separate stream (e.g. screen + mic).
      if (!remoteMs.getTracks().find((t) => t.id === ev.track.id)) {
        remoteMs.addTrack(ev.track);
      }
      setRemoteStream(new MediaStream(remoteMs.getTracks()));
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !callIdRef.current) return;
      fetch(`${API_BASE}/${callIdRef.current}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ type: "ice", candidate: ev.candidate.toJSON() }),
      }).catch(() => {});

      // Also send directly over the WebSocket for low-latency relay
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "ice", candidate: ev.candidate.toJSON() }));
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "closed") {
        // Clear any pending disconnection timer
        if (disconnectedTimerRef.current) {
          clearTimeout(disconnectedTimerRef.current);
          disconnectedTimerRef.current = null;
        }
        setCallState({ phase: "ended", reason: "connection_failed" });
        cleanup();
        setTimeout(() => setCallState({ phase: "idle" }), 3000);
      } else if (state === "disconnected") {
        // Peer may have closed without sending hangup (e.g. browser crash).
        // Give 12 s for ICE to recover before treating it as a lost call.
        disconnectedTimerRef.current = setTimeout(() => {
          if (pcRef.current?.connectionState === "disconnected") {
            setCallState({ phase: "ended", reason: "connection_lost" });
            cleanup();
            setTimeout(() => setCallState({ phase: "idle" }), 3000);
          }
        }, 12_000);
      } else if (state === "connected") {
        // Reconnected — cancel any pending disconnection timer.
        if (disconnectedTimerRef.current) {
          clearTimeout(disconnectedTimerRef.current);
          disconnectedTimerRef.current = null;
        }
      }
    };

    // Mid-call renegotiation: fires when the user adds/removes tracks on demand.
    // Guard: only act once the call is established (callIdRef set) and WS is open.
    pc.onnegotiationneeded = async () => {
      if (isNegotiatingRef.current || !callIdRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      isNegotiatingRef.current = true;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "renegotiate", sdp: offer.sdp }));
      } catch (err) {
        console.error("[call] onnegotiationneeded error:", err);
        isNegotiatingRef.current = false;
      }
    };

    return pc;
  }, [accessToken, cleanup]);

  // ── Start a call (caller side) ────────────────────────────────────────────
  // Media is acquired immediately (user gesture context from the call button).
  const startCall = useCallback(async (
    targetAcct: string,
    callType: "audio" | "video" | "screen"
  ): Promise<string | null> => {
    if (callState.phase !== "idle") return null;
    try {
      const pc = await createPeerConnection(callType);

      // Acquire initial media before creating the offer so the SDP already
      // reflects the tracks we intend to send (sendrecv vs recvonly).
      await acquireAndAttachInitialMedia(pc, callType, false);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await fetch(API_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          target_acct: targetAcct,
          // API stores "screen" as "video" for signaling; the call_type is preserved in client state
          call_type: callType === "screen" ? "video" : callType,
          offer_sdp: offer.sdp,
        }),
      });

      if (!res.ok) {
        if (res.status === 403) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          if (data.error === "call_blocked") {
            cleanup();
            setCallState({ phase: "blocked", targetAcct });
            setTimeout(() => setCallState({ phase: "idle" }), 4000);
            return null;
          }
        }
        cleanup();
        return null;
      }

      const data = await res.json() as { id: string };
      callIdRef.current = data.id;
      connectSignalingWs(data.id);
      setCallState({ phase: "calling", callId: data.id, callType, targetAcct });
      return data.id;
    } catch (err) {
      console.error("[call] startCall error:", err);
      cleanup();
      return null;
    }
  }, [callState.phase, createPeerConnection, acquireAndAttachInitialMedia, accessToken, connectSignalingWs, cleanup]);

  // ── Accept incoming call (callee side) ───────────────────────────────────
  const acceptCall = useCallback(async (): Promise<void> => {
    if (callState.phase !== "incoming") return;
    const { event } = callState;

    try {
      const pc = await createPeerConnection(event.callType);
      callIdRef.current = event.callId;

      await pc.setRemoteDescription({ type: "offer", sdp: event.offerSdp });
      remoteDescSetRef.current = true;
      for (const c of pendingCandidatesRef.current) {
        pc.addIceCandidate(c).catch(() => {});
      }
      pendingCandidatesRef.current = [];

      // Acquire media after setRemoteDescription so tracks are associated with
      // the offer's transceivers. For screen-share calls the callee only gets
      // mic (they receive the caller's screen, not share their own).
      await acquireAndAttachInitialMedia(pc, event.callType, /* calleeMode */ true);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await fetch(`${API_BASE}/${event.callId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ type: "answer", sdp: answer.sdp }),
      });

      connectSignalingWs(event.callId);
      setCallState({
        phase: "active",
        callId: event.callId,
        callType: event.callType,
        peerAcct: event.callerAcct,
      });
    } catch (err) {
      console.error("[call] acceptCall error:", err);
      cleanup();
      setCallState({ phase: "idle" });
    }
  }, [callState, createPeerConnection, acquireAndAttachInitialMedia, accessToken, connectSignalingWs, cleanup]);

  // ── End / decline call ───────────────────────────────────────────────────
  const endCall = useCallback(async (): Promise<void> => {
    const id = callIdRef.current;
    if (id) {
      const signalType =
        callState.phase === "incoming" ? "reject" : "hangup";
      await fetch(`${API_BASE}/${id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ type: signalType }),
      }).catch(() => {});
    }
    cleanup();
    setCallState({ phase: "idle" });
  }, [callState.phase, accessToken, cleanup]);

  // ── Handle streaming "call" events ───────────────────────────────────────
  const handleStreamingEvent = useCallback((event: string, payload: string) => {
    if (event !== "call") return;

    let callPayload: CallEventPayload;
    try { callPayload = JSON.parse(payload) as CallEventPayload; } catch { return; }

    switch (callPayload.type) {
      case "call.incoming":
        if (callState.phase === "idle") {
          setCallState({ phase: "incoming", event: callPayload });
        }
        break;

      case "call.answered":
        if (callState.phase === "calling" && callPayload.callId === callIdRef.current) {
          const pc = pcRef.current;
          if (pc) {
            pc.setRemoteDescription({ type: "answer", sdp: callPayload.answerSdp })
              .then(() => {
                remoteDescSetRef.current = true;
                for (const c of pendingCandidatesRef.current) {
                  pc.addIceCandidate(c).catch(() => {});
                }
                pendingCandidatesRef.current = [];
              })
              .catch((e) => console.error("[call] setRemoteDescription error:", e));
          }
          setCallState((prev) =>
            prev.phase === "calling"
              ? { phase: "active", callId: prev.callId, callType: prev.callType, peerAcct: prev.targetAcct }
              : prev
          );
        }
        break;

      case "call.ice":
        if (callPayload.callId === callIdRef.current) {
          const pc = pcRef.current;
          if (!pc) return;
          if (remoteDescSetRef.current) {
            pc.addIceCandidate(callPayload.candidate).catch(() => {});
          } else {
            pendingCandidatesRef.current.push(callPayload.candidate);
          }
        }
        break;

      case "call.rejected":
      case "call.ended":
        if (callPayload.callId === callIdRef.current) {
          cleanup();
          setCallState({ phase: "ended", reason: callPayload.type });
          setTimeout(() => setCallState({ phase: "idle" }), 3000);
        }
        break;
    }
  }, [callState.phase, cleanup]);

  // ── Audio/video toggles (acquire media on demand) ────────────────────────
  const toggleMute = useCallback(async (): Promise<void> => {
    const pc = pcRef.current;
    if (!pc) return;

    if (isMuted) {
      // Enable mic: acquire if first time, otherwise re-enable existing track
      try {
        if (!micStreamRef.current) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micStreamRef.current = stream;
          const track = stream.getAudioTracks()[0];
          pc.addTrack(track, stream);  // triggers onnegotiationneeded → renegotiate with peer
          // Update localStream (combined) for any downstream uses
          setLocalStream((prev) => {
            const ms = new MediaStream([...(prev?.getTracks() ?? []), track]);
            return ms;
          });
        } else {
          micStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = true; });
        }
        setIsMuted(false);
      } catch (err) {
        console.error("[call] toggleMute (enable) error:", err);
      }
    } else {
      // Mute: disable tracks (keep sender, avoids renegotiation)
      micStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
      setIsMuted(true);
    }
  }, [isMuted]);

  const toggleVideo = useCallback(async (): Promise<void> => {
    const pc = pcRef.current;
    if (!pc) return;

    if (isVideoOff) {
      // Enable camera: acquire if first time, otherwise re-enable existing track
      try {
        if (!camStreamRef.current) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          });
          camStreamRef.current = stream;
          const track = stream.getVideoTracks()[0];
          pc.addTrack(track, stream);  // triggers onnegotiationneeded
          setLocalStream((prev) => {
            const ms = new MediaStream([...(prev?.getTracks() ?? []), track]);
            return ms;
          });
        } else {
          camStreamRef.current.getVideoTracks().forEach((t) => { t.enabled = true; });
        }
        setIsVideoOff(false);
      } catch (err) {
        console.error("[call] toggleVideo (enable) error:", err);
      }
    } else {
      // Disable camera track (keep sender)
      camStreamRef.current?.getVideoTracks().forEach((t) => { t.enabled = false; });
      setIsVideoOff(true);
    }
  }, [isVideoOff]);

  // ── Screen share toggle ───────────────────────────────────────────────────
  const toggleScreenShare = useCallback(async (): Promise<void> => {
    const pc = pcRef.current;
    if (!pc) return;

    if (isSharingScreen) {
      // Stop screen share — restore camera track if available, else clear the video sender
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        const camTrack = camStreamRef.current?.getVideoTracks()[0];
        if (camTrack && !isVideoOff) {
          await sender.replaceTrack(camTrack);
        } else {
          // No camera acquired or camera is off — remove video from sender
          await sender.replaceTrack(null);
        }
      }
      setIsSharingScreen(false);
      setScreenStream(null);
    } else {
      // Start screen share
      try {
        const displayStream = await (navigator.mediaDevices as MediaDevices & {
          getDisplayMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
        }).getDisplayMedia({ video: true, audio: false });
        screenStreamRef.current = displayStream;
        const screenTrack = displayStream.getVideoTracks()[0];
        // Replace the video sender track
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) {
          await sender.replaceTrack(screenTrack);
        } else {
          // Audio-only call — add the screen track as a new sender
          pc.addTrack(screenTrack, displayStream);
        }
        // Auto-stop when the user clicks "Stop sharing" in the browser UI
        screenTrack.onended = () => { toggleScreenShare().catch(() => {}); };
        setIsSharingScreen(true);
        setScreenStream(displayStream);
      } catch (err) {
        console.error("[call] getDisplayMedia error:", err);
      }
    }
  }, [isSharingScreen, isVideoOff]);

  // Cleanup on unmount
  useEffect(() => () => { cleanup(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    callState,
    localStream,
    remoteStream,
    startCall,
    acceptCall,
    endCall,
    toggleMute,
    toggleVideo,
    toggleScreenShare,
    isMuted,
    isVideoOff,
    isSharingScreen,
    screenStream,
    handleStreamingEvent,
  };
}
