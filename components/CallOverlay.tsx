/**
 * CallOverlay — Global overlay component for incoming and active WebRTC calls.
 *
 * Renders:
 *   - An incoming call notification with Accept / Decline buttons
 *   - An active call panel with local + remote video, mute, video, hangup controls
 *
 * This component is mounted once at the top of the layout and is driven by the
 * useCall hook.  It subscribes to the authenticated user's home Mastodon streaming
 * channel to receive call events.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCall } from "@/lib/webrtc/use-call";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";

interface CallOverlayProps {
  /** Mastodon OAuth access token for the authenticated user. */
  accessToken: string;
}

export function CallOverlay({ accessToken }: CallOverlayProps) {
  const {
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
  } = useCall(accessToken);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // Wire up streaming events → call hook
  useTimelineStream("user", accessToken, handleStreamingEvent);

  // Listen for imperative start-call requests dispatched by call buttons in other components
  useEffect(() => {
    const handler = (ev: Event) => {
      const { targetAcct, callType } = (ev as CustomEvent<{ targetAcct: string; callType: "audio" | "video" | "screen" }>).detail;
      startCall(targetAcct, callType).catch(() => {});
    };
    window.addEventListener("cf-ap:start-call", handler);
    return () => window.removeEventListener("cf-ap:start-call", handler);
  }, [startCall]);

  // Attach media streams to video elements
  // Local PiP: show screen capture when sharing, otherwise show camera feed
  useEffect(() => {
    if (localVideoRef.current) {
      const src = isSharingScreen && screenStream ? screenStream : localStream;
      localVideoRef.current.srcObject = src ?? null;
    }
  }, [localStream, screenStream, isSharingScreen]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  if (callState.phase === "idle") return null;

  // ── Incoming call UI ──────────────────────────────────────────────────────
  if (callState.phase === "incoming") {
    const { event } = callState;
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ backgroundColor: "rgba(0,0,0,0.75)" }}
        role="dialog"
        aria-modal="true"
        aria-label="Incoming call"
      >
        <div
          className="rounded-2xl shadow-2xl p-8 flex flex-col items-center gap-5 w-80"
          style={{
            backgroundColor: "var(--color-base-100, #1e1e2e)",
            color: "var(--color-base-content, #cdd6f4)",
            border: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          {event.callerAvatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={event.callerAvatar}
              alt={event.callerDisplayName}
              className="w-20 h-20 rounded-full object-cover"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center text-3xl">
              {event.callerDisplayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="text-center">
            <p className="font-semibold text-lg leading-tight" style={{ color: "inherit" }}>{event.callerDisplayName}</p>
            <p className="text-sm opacity-70" style={{ color: "inherit" }}>{event.callerAcct}</p>
          </div>
          <p className="text-sm opacity-60" style={{ color: "inherit" }}>
            Incoming {event.callType === "video" ? "video" : "voice"} call…
          </p>
          <div className="flex gap-4 mt-2">
            <button
              onClick={endCall}
              className="w-14 h-14 rounded-full bg-error text-white flex items-center justify-center text-2xl shadow"
              aria-label="Decline call"
            >
              📵
            </button>
            <button
              onClick={acceptCall}
              className="w-14 h-14 rounded-full bg-success text-white flex items-center justify-center text-2xl shadow"
              aria-label="Accept call"
            >
              📞
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Blocked ───────────────────────────────────────────────────────────────
  if (callState.phase === "blocked") {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <div
          className="rounded-xl shadow-2xl px-5 py-4 flex items-center gap-3 w-72"
          style={{
            backgroundColor: "var(--color-base-100, #1e1e2e)",
            border: "1px solid rgba(255,80,80,0.4)",
            color: "var(--color-base-content, #cdd6f4)",
          }}
        >
          <span className="text-2xl">🚫</span>
          <div>
            <p className="font-semibold text-sm">Llamada bloqueada</p>
            <p className="text-xs opacity-70">{callState.targetAcct} te ha bloqueado.</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Calling (waiting for answer) ─────────────────────────────────────────
  if (callState.phase === "calling") {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <div className="bg-base-100 rounded-2xl shadow-2xl p-5 flex flex-col items-center gap-3 w-64">
          <p className="text-sm font-medium">
            Calling {callState.targetAcct}…
          </p>
          <div className="flex gap-2 items-center">
            <span className="animate-pulse text-2xl">📞</span>
          </div>
          <button
            onClick={endCall}
            className="btn btn-error btn-sm w-full"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Active call UI ────────────────────────────────────────────────────────
  if (callState.phase === "active") {
    const callType = callState.callType;
    // Show the video panel when: call was initiated as video/screen OR camera/screen is currently active
    const hasVideoPanel = callType === "video" || callType === "screen" || !isVideoOff || isSharingScreen;
    // Local PiP should only render when there's actually something to display
    const localVideoStream = isSharingScreen && screenStream ? screenStream : localStream;
    const showLocalPip = localVideoStream != null && (localVideoStream.getVideoTracks().length > 0);
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <div className="bg-base-200 rounded-2xl shadow-2xl overflow-hidden w-72 flex flex-col">
          {/* Remote video / audio panel */}
          {hasVideoPanel ? (
            <div className="relative w-full aspect-video bg-black">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
              {/* Local video (PiP) — only shown when local video is active */}
              {showLocalPip && (
                <div className="absolute bottom-2 right-2 w-20 aspect-video bg-black rounded-lg overflow-hidden">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="p-4 flex flex-col items-center gap-2">
              <span className="text-3xl">🎙️</span>
              <p className="text-sm font-medium">{callState.peerAcct}</p>
              {/* Hidden audio element for remote audio */}
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio ref={remoteVideoRef as React.RefObject<HTMLAudioElement>} autoPlay />
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center justify-center gap-3 p-3 bg-base-300">
            <button
              onClick={() => void toggleMute()}
              className={`btn btn-circle btn-sm ${isMuted ? "btn-error" : "btn-ghost"}`}
              aria-label={isMuted ? "Unmute" : "Mute"}
              title={isMuted ? "Enable microphone" : "Mute microphone"}
            >
              {isMuted ? "🔇" : "🎙️"}
            </button>
            <button
              onClick={() => void toggleVideo()}
              className={`btn btn-circle btn-sm ${isVideoOff ? "btn-ghost" : "btn-ghost"}`}
              aria-label={isVideoOff ? "Enable camera" : "Disable camera"}
              title={isVideoOff ? "Enable camera" : "Disable camera"}
            >
              {isVideoOff ? "📷" : "📹"}
            </button>
            <button
              onClick={() => void toggleScreenShare()}
              className={`btn btn-circle btn-sm ${isSharingScreen ? "btn-warning" : "btn-ghost"}`}
              aria-label={isSharingScreen ? "Stop sharing screen" : "Share screen"}
              title={isSharingScreen ? "Stop sharing screen" : "Share screen"}
            >
              🖥️
            </button>
            <button
              onClick={endCall}
              className="btn btn-circle btn-sm btn-error"
              aria-label="End call"
              title="End call"
            >
              📵
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Call ended banner ─────────────────────────────────────────────────────
  if (callState.phase === "ended") {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <div className="bg-error text-white rounded-xl px-4 py-3 shadow-lg text-sm">
          Call ended{callState.reason ? ` (${callState.reason.replace(/_/g, " ")})` : ""}
        </div>
      </div>
    );
  }

  return null;
}

// ── Public hook for initiating calls from other components ───────────────────

/**
 * Returns a function to start a call from any component.
 * Usage:  const { startCall } = useStartCall(accessToken);
 */
export function useStartCallButton(accessToken: string | null | undefined) {
  const [pending, setPending] = useState(false);

  const startCall = useCallback(
    async (targetAcct: string, callType: "audio" | "video" | "screen") => {
      if (!accessToken) return;
      setPending(true);
      try {
        // The actual call setup is handled by the global CallOverlay hook.
        // Here we dispatch a custom event that CallOverlay listens to.
        window.dispatchEvent(
          new CustomEvent("cf-ap:start-call", { detail: { targetAcct, callType } })
        );
      } finally {
        setPending(false);
      }
    },
    [accessToken]
  );

  return { startCall, pending };
}
