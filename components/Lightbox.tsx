"use client";

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/Icon";
import { useLocale } from "@/lib/i18n";
import { MediaPlayer } from "@/components/MediaPlayer";
import { youTubeEmbedUrl } from "@/lib/youtube";

interface LightboxItem {
  url: string;
  preview_url?: string | null;
  description?: string | null;
  type: string;
  /** Provider embed URL (YouTube) rendered as an iframe player. */
  embed_url?: string | null;
}

interface LightboxProps {
  media: LightboxItem[];
  index: number;
  onClose: () => void;
  onNav: (index: number) => void;
}

export function Lightbox({ media, index, onClose, onNav }: LightboxProps) {
  const item = media[index];
  const { t } = useLocale();
  const [imgLoaded, setImgLoaded] = useState(false);
  const onCloseRef = useRef(onClose);
  const onNavRef = useRef(onNav);
  const indexRef = useRef(index);

  // Reset the loading indicator whenever the displayed item changes
  const [prevImgIndex, setPrevImgIndex] = useState(index);
  if (prevImgIndex !== index) {
    setPrevImgIndex(index);
    setImgLoaded(false);
  }

  // Keep latest callbacks/index available to the keydown listener
  useEffect(() => {
    onCloseRef.current = onClose;
    onNavRef.current = onNav;
    indexRef.current = index;
  });

  useEffect(() => {
    document.body.style.overflow = "hidden";

    const handleKey = (e: KeyboardEvent) => {
      const i = indexRef.current;
      if (e.key === "Escape") onCloseRef.current();
      if (e.key === "ArrowLeft" && i > 0) onNavRef.current(i - 1);
      if (e.key === "ArrowRight" && i < media.length - 1) onNavRef.current(i + 1);
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [index, media.length]);

  if (!item) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.a11y_media_viewer}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.92)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "2rem",
      }}
      onClick={onClose}
    >
      {/* Close */}
      <button
        onClick={onClose}
        aria-label={t.action_close}
        style={{
          position: "absolute", top: "1rem", right: "1rem",
          background: "rgba(255,255,255,0.12)", color: "#fff", border: "none",
          borderRadius: "50%", width: 40, height: 40,
          fontSize: "1.1rem", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 2,
        }}
      >
        <Icon name="times" color="#fff" />
      </button>

      {/* Prev */}
      {index > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNav(index - 1); }}
          aria-label={t.a11y_previous_media}
          style={{
            position: "absolute", left: "0.75rem", top: "50%", transform: "translateY(-50%)",
            background: "rgba(255,255,255,0.12)", color: "#fff", border: "none",
            borderRadius: "50%", width: 44, height: 44,
            fontSize: "1.6rem", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2,
          }}
        >
          <Icon name="chevron-left" color="#fff" />
        </button>
      )}

      {/* Content */}
      <div
        style={{ maxWidth: "90vw", maxHeight: "88vh", position: "relative" }}
        onClick={(e) => e.stopPropagation()}
      >
        {!imgLoaded && !["video", "audio", "gifv"].includes(item.type) && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "rgba(255,255,255,0.4)", fontSize: "2rem",
          }}>
            <Icon name="hourglass" spin color="rgba(255,255,255,0.4)" size="2rem" />
          </div>
        )}
        {youTubeEmbedUrl(item.embed_url, item.url) ? (
          <div style={{ width: "min(90vw, 1100px)" }}>
            <div style={{ width: "100%", aspectRatio: "16/9", background: "#000", borderRadius: "var(--radius)", overflow: "hidden" }}>
              <iframe
                src={youTubeEmbedUrl(item.embed_url, item.url)!}
                title={item.description ?? t.a11y_media_viewer}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                style={{ width: "100%", height: "100%", border: "none", display: "block" }}
              />
            </div>
            <a
              href={item.url}
              target="_blank"
              rel="nofollow noopener noreferrer"
              style={{ display: "block", marginTop: "0.6rem", textAlign: "center", color: "rgba(255,255,255,0.65)", fontSize: "0.8rem", textDecoration: "none" }}
            >
              <Icon name="external-link" size="0.75rem" color="currentColor" /> {t.ap_open_original}
              {" · "}
              {(() => { try { return new URL(item.url).hostname; } catch { return item.url; } })()}
            </a>
          </div>
        ) : item.type === "video" || item.type === "gifv" ? (
          <div style={{ width: "min(90vw, 1100px)", height: "min(85vh, 640px)" }}>
            <MediaPlayer
              src={item.url}
              poster={item.preview_url}
              description={item.description}
              kind={item.type === "gifv" ? "gifv" : "video"}
              variant="lightbox"
              autoPlay
              loop={item.type === "gifv"}
            />
          </div>
        ) : item.type === "audio" ? (
          <div style={{ textAlign: "center", padding: "1rem 0" }}>
            <MediaPlayer
              src={item.url}
              kind="audio"
              variant="lightbox"
              autoPlay
              description={item.description}
            />
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- full-size viewer needs natural aspect ratio (maxWidth/maxHeight + objectFit contain), which next/image fill cannot express
          <img
            src={item.url}
            alt={item.description ?? ""}
            onLoad={() => setImgLoaded(true)}
            style={{
              maxWidth: "90vw", maxHeight: "85vh",
              objectFit: "contain",
              borderRadius: "var(--radius)",
              display: "block",
              opacity: imgLoaded ? 1 : 0,
              transition: "opacity 0.2s",
            }}
          />
        )}
        {item.description && item.type !== "audio" && (
          <p style={{
            textAlign: "center", color: "rgba(255,255,255,0.65)",
            fontSize: "0.82rem", maxWidth: "60ch", margin: "0.5rem auto 0",
          }}>
            {item.description}
          </p>
        )}
      </div>

      {/* Next */}
      {index < media.length - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNav(index + 1); }}
          aria-label={t.a11y_next_media}
          style={{
            position: "absolute", right: "0.75rem", top: "50%", transform: "translateY(-50%)",
            background: "rgba(255,255,255,0.12)", color: "#fff", border: "none",
            borderRadius: "50%", width: 44, height: 44,
            fontSize: "1.6rem", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2,
          }}
        >
          <Icon name="chevron-right" color="#fff" />
        </button>
      )}

      {/* Counter */}
      {media.length > 1 && (
        <div style={{
          position: "absolute", bottom: "1rem", left: "50%", transform: "translateX(-50%)",
          background: "rgba(0,0,0,0.55)", color: "#fff",
          padding: "0.25rem 0.75rem", borderRadius: "var(--radius)",
          fontSize: "0.82rem",
        }}>
          {index + 1} / {media.length}
        </div>
      )}
    </div>
  );
}
