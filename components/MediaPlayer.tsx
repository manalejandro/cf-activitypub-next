"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useLocale } from "@/lib/i18n";

export type MediaPlayerKind = "video" | "audio" | "gifv";

export interface MediaPlayerProps {
  src: string;
  /** Preview image shown before playing (videos/GIFVs). */
  poster?: string | null;
  /** Alt text / caption shown under audio players. */
  description?: string | null;
  kind?: MediaPlayerKind;
  /** `inline` fits a timeline card; `lightbox` is the enlarged viewer. */
  variant?: "inline" | "lightbox";
  autoPlay?: boolean;
  loop?: boolean;
  muted?: boolean;
}

/** `m:ss` / `h:mm:ss` media timestamp. */
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Progress bar with buffered/secondary fill, usable as a scrubber. */
function MediaBar({
  played,
  buffered,
  onSeek,
  label,
  tone = "light",
  tall = false,
}: {
  played: number;
  buffered?: number;
  onSeek: (ratio: number) => void;
  label: string;
  tone?: "light" | "accent";
  tall?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const height = tall ? 5 : 4;
  const track = tone === "light" ? "rgba(255,255,255,0.28)" : "var(--border)";
  const bufferedFill = tone === "light" ? "rgba(255,255,255,0.4)" : "color-mix(in srgb, var(--accent) 25%, transparent)";

  const seekFromEvent = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSeek(clampRatio((clientX - rect.left) / rect.width));
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(played * 100)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        seekFromEvent(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) seekFromEvent(e.clientX);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onSeek(clampRatio(played - 0.05));
        if (e.key === "ArrowRight") onSeek(clampRatio(played + 0.05));
      }}
      style={{
        position: "relative",
        flex: 1,
        minWidth: 0,
        height: `${height + 12}px`,
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        touchAction: "none",
      }}
    >
      <div style={{ position: "absolute", left: 0, right: 0, height: `${height}px`, borderRadius: `${height}px`, background: track, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${clampRatio(buffered ?? played) * 100}%`, background: bufferedFill }} />
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${clampRatio(played) * 100}%`, background: tone === "light" ? "#fff" : "var(--accent)" }} />
      </div>
      <div
        style={{
          position: "absolute",
          left: `calc(${clampRatio(played) * 100}% - ${height + 2}px)`,
          width: `${(height + 2) * 2}px`,
          height: `${(height + 2) * 2}px`,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
          pointerEvents: "none",
          transition: "left 0.1s linear",
        }}
      />
    </div>
  );
}

/** Deterministic bar pattern for the audio waveform (stable across renders). */
function waveformHeights(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 0.22 + 0.78 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.53)));
}

function AudioWaveform({
  played,
  onSeek,
  label,
  tone = "light",
  height = 34,
}: {
  played: number;
  onSeek: (ratio: number) => void;
  label: string;
  tone?: "light" | "accent";
  height?: number;
}) {
  const heights = useMemo(() => waveformHeights(44), []);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playedColor = tone === "light" ? "#fff" : "var(--accent)";
  const idleColor = tone === "light" ? "rgba(255,255,255,0.32)" : "var(--border)";

  const seekFromEvent = (clientX: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSeek(clampRatio((clientX - rect.left) / rect.width));
  };

  return (
    <div
      ref={wrapRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(played * 100)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        seekFromEvent(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) seekFromEvent(e.clientX);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onSeek(clampRatio(played - 0.05));
        if (e.key === "ArrowRight") onSeek(clampRatio(played + 0.05));
      }}
      style={{ display: "flex", alignItems: "center", gap: "2px", height: `${height}px`, cursor: "pointer", touchAction: "none" }}
    >
      {heights.map((h, i) => {
        const fill = (i + 0.5) / heights.length <= played;
        return (
          <span
            key={i}
            style={{
              flex: 1,
              height: `${Math.round(h * 100)}%`,
              borderRadius: "2px",
              background: fill ? playedColor : idleColor,
              transition: "background 0.15s",
            }}
          />
        );
      })}
    </div>
  );
}

export function MediaPlayer({
  src,
  poster,
  description,
  kind = "video",
  variant = "inline",
  autoPlay = false,
  loop = false,
  muted: initiallyMuted = false,
}: MediaPlayerProps) {
  const { t } = useLocale();
  const isAudio = kind === "audio";
  const isGifv = kind === "gifv";
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [muted, setMuted] = useState(initiallyMuted);
  const [volume, setVolume] = useState(1);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const canUseControls = !isGifv || variant === "lightbox";
  const showControls = canUseControls && (controlsVisible || !playing);
  const playedRatio = duration > 0 ? clampRatio(current / duration) : 0;
  const bufferedRatio = duration > 0 ? clampRatio(buffered / duration) : 0;

  const poke = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      const el = mediaRef.current;
      if (el && !el.paused && !el.ended) setControlsVisible(false);
    }, 2600);
  }, []);

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const togglePlay = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused || el.ended) {
      const attempt = el.play();
      if (attempt && typeof attempt.catch === "function") attempt.catch(() => setPlaying(false));
    } else {
      el.pause();
    }
    poke();
  }, [poke]);

  const seekTo = useCallback((ratio: number) => {
    const el = mediaRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    el.currentTime = clampRatio(ratio) * el.duration;
    setCurrent(el.currentTime);
    poke();
  }, [poke]);

  const toggleMute = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
    if (!el.muted && el.volume === 0) {
      el.volume = 1;
      setVolume(1);
    }
  }, []);

  const changeVolume = useCallback((value: number) => {
    const el = mediaRef.current;
    if (!el) return;
    el.volume = clampRatio(value);
    el.muted = el.volume === 0;
    setVolume(el.volume);
    setMuted(el.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
      return;
    }
    void containerRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = mediaRef.current;
    if (!el) return;
    switch (e.key) {
      case " ":
      case "k":
      case "K":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowLeft":
        e.preventDefault();
        seekTo(playedRatio - (5 / Math.max(1, duration)));
        break;
      case "ArrowRight":
        e.preventDefault();
        seekTo(playedRatio + (5 / Math.max(1, duration)));
        break;
      case "ArrowUp":
        e.preventDefault();
        changeVolume(volume + 0.1);
        break;
      case "ArrowDown":
        e.preventDefault();
        changeVolume(volume - 0.1);
        break;
      case "m":
      case "M":
        e.preventDefault();
        toggleMute();
        break;
      case "f":
      case "F":
        e.preventDefault();
        toggleFullscreen();
        break;
      default:
        break;
    }
    poke();
  };

  const mediaEvents = {
    onPlay: () => { setPlaying(true); setWaiting(false); poke(); },
    onPause: () => { setPlaying(false); setControlsVisible(true); },
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => setCurrent(e.currentTarget.currentTime || 0),
    onDurationChange: (e: React.SyntheticEvent<HTMLMediaElement>) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0),
    onProgress: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const el = e.currentTarget;
      if (el.buffered.length > 0) setBuffered(el.buffered.end(el.buffered.length - 1));
    },
    onWaiting: () => setWaiting(true),
    onPlaying: () => setWaiting(false),
    onVolumeChange: (e: React.SyntheticEvent<HTMLMediaElement>) => { setMuted(e.currentTarget.muted); setVolume(e.currentTarget.volume); },
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0);
    },
    onEnded: () => setControlsVisible(true),
  };

  const controlButtonStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "none",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    padding: "0.2rem",
    fontSize: "0.9rem",
    lineHeight: 1,
  };

  if (isAudio) {
    const lightbox = variant === "lightbox";
    const textColor = lightbox ? "#fff" : "var(--text-primary)";
    const mutedColor = lightbox ? "rgba(255,255,255,0.6)" : "var(--text-muted)";
    return (
      <div
        ref={containerRef}
        className="media-player media-player--audio"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          padding: lightbox ? "1rem 1.25rem" : "0.75rem",
          background: lightbox ? "rgba(255,255,255,0.06)" : "var(--bg-elevated)",
          border: `1px solid ${lightbox ? "rgba(255,255,255,0.12)" : "var(--border)"}`,
          borderRadius: "var(--radius)",
          width: lightbox ? "min(560px, 86vw)" : "100%",
          boxSizing: "border-box",
        }}
      >
        <audio
          ref={mediaRef as React.RefObject<HTMLAudioElement>}
          src={src}
          autoPlay={autoPlay}
          loop={loop}
          preload="metadata"
          aria-label={description ?? t.media_play}
          {...mediaEvents}
        />
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? t.media_pause : t.media_play}
          title={playing ? t.media_pause : t.media_play}
          style={{
            width: lightbox ? 52 : 44,
            height: lightbox ? 52 : 44,
            flexShrink: 0,
            borderRadius: "50%",
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: lightbox ? "1.15rem" : "1rem",
          }}
        >
          <Icon name={waiting ? "hourglass" : playing ? "pause" : "play"} color="#fff" spin={waiting} />
        </button>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
          <AudioWaveform
            played={playedRatio}
            onSeek={seekTo}
            label={t.media_seek}
            tone={lightbox ? "light" : "accent"}
            height={lightbox ? 44 : 32}
          />
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", fontSize: "0.72rem", color: mutedColor }}>
            <span>{formatMediaTime(current)} / {formatMediaTime(duration)}</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? t.media_unmute : t.media_mute}
                title={muted ? t.media_unmute : t.media_mute}
                style={{ ...controlButtonStyle, color: mutedColor }}
              >
                <Icon name={muted || volume === 0 ? "volume-off" : "volume-up"} color="currentColor" />
              </button>
              <input
                className="media-player__volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => changeVolume(Number(e.target.value))}
                aria-label={t.media_volume}
                style={{ accentColor: "var(--accent)", width: 64 }}
              />
            </span>
          </div>
          {description && (
            <div style={{ fontSize: "0.75rem", color: mutedColor, overflow: "hidden", textOverflow: "ellipsis" }}>
              {description}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
          {lightbox && (
            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? t.media_exit_fullscreen : t.media_fullscreen}
              title={isFullscreen ? t.media_exit_fullscreen : t.media_fullscreen}
              style={{ ...controlButtonStyle, color: textColor === "#fff" ? "#fff" : "var(--text-muted)" }}
            >
              <Icon name={isFullscreen ? "compress" : "expand"} color="currentColor" />
            </button>
          )}
          <a
            href={src}
            download
            aria-label={t.media_download}
            title={t.media_download}
            style={{ ...controlButtonStyle, color: mutedColor }}
          >
            <Icon name="download" color="currentColor" />
          </a>
        </div>
      </div>
    );
  }

  const isFullscreenSized = isFullscreen;
  return (
    <div
      ref={containerRef}
      className="media-player"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={poke}
      onPointerDown={poke}
      onFocus={poke}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: isAudio ? undefined : variant === "lightbox" ? "min(60vh, 520px)" : undefined,
        background: "#000",
        borderRadius: isFullscreenSized ? 0 : "var(--radius)",
        overflow: "hidden",
        outline: "none",
      }}
    >
      <video
        ref={mediaRef as React.RefObject<HTMLVideoElement>}
        src={src}
        poster={poster ?? undefined}
        autoPlay={autoPlay}
        loop={loop}
        muted={initiallyMuted}
        playsInline
        preload="metadata"
        aria-label={description ?? t.action_view_media}
        {...mediaEvents}
        onClick={() => { if (canUseControls) togglePlay(); }}
        onDoubleClick={() => { if (variant === "lightbox") toggleFullscreen(); }}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          objectFit: "contain",
          background: "#000",
        }}
      />

      {/* Big play button while paused (timeline + lightbox). */}
      {canUseControls && !playing && !waiting && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); togglePlay(); }}
          aria-label={t.media_play}
          title={t.media_play}
          style={{
            position: "absolute",
            inset: 0,
            margin: "auto",
            width: variant === "lightbox" ? 76 : 62,
            height: variant === "lightbox" ? 76 : 62,
            borderRadius: "50%",
            border: "none",
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: variant === "lightbox" ? "1.7rem" : "1.4rem",
            backdropFilter: "blur(2px)",
          }}
        >
          <Icon name="play" color="#fff" />
        </button>
      )}

      {waiting && playing && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <Icon name="hourglass" spin size="1.6rem" color="rgba(255,255,255,0.9)" />
        </div>
      )}

      {/* Custom control bar */}
      {canUseControls && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            padding: "1.4rem 0.6rem 0.5rem",
            background: "linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0))",
            opacity: showControls ? 1 : 0,
            transition: "opacity 0.2s",
            pointerEvents: showControls ? "auto" : "none",
          }}
        >
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? t.media_pause : t.media_play}
            title={playing ? t.media_pause : t.media_play}
            style={{ ...controlButtonStyle, fontSize: "1rem" }}
          >
            <Icon name={playing ? "pause" : "play"} color="#fff" />
          </button>
          <span style={{ color: "#fff", fontSize: "0.72rem", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
            {formatMediaTime(current)} / {formatMediaTime(duration)}
          </span>
          <MediaBar played={playedRatio} buffered={bufferedRatio} onSeek={seekTo} label={t.media_seek} />
          <button
            type="button"
            onClick={toggleMute}
            aria-label={muted ? t.media_unmute : t.media_mute}
            title={muted ? t.media_unmute : t.media_mute}
            style={controlButtonStyle}
          >
            <Icon name={muted || volume === 0 ? "volume-off" : "volume-up"} color="#fff" />
          </button>
          <input
            className="media-player__volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => changeVolume(Number(e.target.value))}
            aria-label={t.media_volume}
            style={{ accentColor: "var(--accent)", width: 64 }}
          />
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? t.media_exit_fullscreen : t.media_fullscreen}
            title={isFullscreen ? t.media_exit_fullscreen : t.media_fullscreen}
            style={controlButtonStyle}
          >
            <Icon name={isFullscreen ? "compress" : "expand"} color="#fff" />
          </button>
          <a href={src} download aria-label={t.media_download} title={t.media_download} style={controlButtonStyle}>
            <Icon name="download" color="#fff" />
          </a>
        </div>
      )}
    </div>
  );
}
