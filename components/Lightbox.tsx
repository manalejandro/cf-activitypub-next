"use client";

import { useState, useEffect, useRef } from "react";

interface LightboxItem {
  url: string;
  preview_url?: string | null;
  description?: string | null;
  type: string;
}

interface LightboxProps {
  media: LightboxItem[];
  index: number;
  onClose: () => void;
  onNav: (index: number) => void;
}

export function Lightbox({ media, index, onClose, onNav }: LightboxProps) {
  const item = media[index];
  const [imgLoaded, setImgLoaded] = useState(false);
  const onCloseRef = useRef(onClose);
  const onNavRef = useRef(onNav);
  const indexRef = useRef(index);

  onCloseRef.current = onClose;
  onNavRef.current = onNav;
  indexRef.current = index;

  useEffect(() => {
    setImgLoaded(false);
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
        style={{
          position: "absolute", top: "1rem", right: "1rem",
          background: "rgba(255,255,255,0.12)", color: "#fff", border: "none",
          borderRadius: "50%", width: 40, height: 40,
          fontSize: "1.1rem", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          zIndex: 2,
        }}
      >
        ✕
      </button>

      {/* Prev */}
      {index > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNav(index - 1); }}
          style={{
            position: "absolute", left: "0.75rem", top: "50%", transform: "translateY(-50%)",
            background: "rgba(255,255,255,0.12)", color: "#fff", border: "none",
            borderRadius: "50%", width: 44, height: 44,
            fontSize: "1.6rem", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2,
          }}
        >
          ‹
        </button>
      )}

      {/* Content */}
      <div
        style={{ maxWidth: "90vw", maxHeight: "88vh", position: "relative" }}
        onClick={(e) => e.stopPropagation()}
      >
        {!imgLoaded && item.type !== "video" && item.type !== "audio" && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "rgba(255,255,255,0.4)", fontSize: "2rem",
          }}>
            ⏳
          </div>
        )}
        {item.type === "video" ? (
          <video
            src={item.url}
            controls
            autoPlay
            style={{
              maxWidth: "90vw", maxHeight: "85vh",
              borderRadius: "var(--radius)", display: "block",
            }}
          />
        ) : item.type === "audio" ? (
          <div style={{ textAlign: "center", padding: "2rem 1rem" }}>
            <div style={{ fontSize: "5rem", marginBottom: "1.25rem" }}>🎵</div>
            <audio
              src={item.url}
              controls
              autoPlay
              style={{ width: "min(480px, 80vw)", outline: "none" }}
            />
            {item.description && (
              <p style={{ color: "rgba(255,255,255,0.65)", fontSize: "0.82rem", marginTop: "0.75rem", maxWidth: "60ch" }}>
                {item.description}
              </p>
            )}
          </div>
        ) : (
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
        {item.description && (
          <p style={{
            textAlign: "center", color: "rgba(255,255,255,0.65)",
            fontSize: "0.82rem", marginTop: "0.5rem", maxWidth: "60ch", margin: "0.5rem auto 0",
          }}>
            {item.description}
          </p>
        )}
      </div>

      {/* Next */}
      {index < media.length - 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNav(index + 1); }}
          style={{
            position: "absolute", right: "0.75rem", top: "50%", transform: "translateY(-50%)",
            background: "rgba(255,255,255,0.12)", color: "#fff", border: "none",
            borderRadius: "50%", width: 44, height: 44,
            fontSize: "1.6rem", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2,
          }}
        >
          ›
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
