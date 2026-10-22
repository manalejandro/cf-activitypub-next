"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useLocale } from "@/lib/i18n";
import { mediaDownloadName } from "@/lib/media/filename";
import {
  DOCUMENT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  documentPreviewUrl,
  readCappedText,
  type CappedText,
} from "@/lib/media/document-preview";
import { documentIcon, formatBytes, mediaFileName } from "@/lib/media/upload-client";

/**
 * Document viewer — the media player's counterpart for PDFs and text files.
 *
 * A PDF is framed with the browser's own viewer (an `<iframe>`: Chrome, Firefox
 * and Safari all render PDFs natively, and our media path serves them with
 * `Content-Type: application/pdf` and no `X-Frame-Options`). Text files are
 * fetched — first 256 KB only, via `Range` — and rendered as **text**, never as
 * HTML. Anything else (a .docx, a .zip) says so and offers the download.
 *
 * Chrome mirrors the lightbox: fixed overlay, Escape/backdrop to close, the
 * page scroll locked, and the actions the file needs — open in a new tab,
 * download, close.
 */
export interface ViewableDocument {
  url: string;
  description?: string | null;
  meta?: { original?: { size?: string } };
}

export function DocumentViewer({ attachment, onClose }: { attachment: ViewableDocument; onClose: () => void }) {
  const { t } = useLocale();
  const kind = documentPreviewKind(attachment.url);
  const href = documentPreviewUrl(attachment.url);
  const name = attachment.description || mediaFileName(attachment.url) || t.media_document;
  const fileSize = Number(attachment.meta?.original?.size ?? "");
  const extension = (mediaFileName(attachment.url)?.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? "").toUpperCase();
  const details = [extension, Number.isFinite(fileSize) && fileSize > 0 ? formatBytes(fileSize) : null].filter(Boolean).join(" · ");

  const [text, setText] = useState<CappedText | null>(null);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  useEffect(() => {
    if (kind !== "text") return;
    let cancelled = false;
    // `Range` keeps a 32 MB log from being downloaded in full; the serve path
    // answers 206 + `content-range` so the viewer knows the real size. Remote
    // (uncached) files are refused by our CSP `connect-src` and end up in the
    // "open in a new tab" fallback, which is the honest answer anyway.
    const run = async () => {
      setText(null);
      setFailed(false);
      try {
        const response = await fetch(href, {
          headers: { Range: `bytes=0-${DOCUMENT_PREVIEW_MAX_BYTES - 1}` },
          credentials: "omit",
        });
        if (!response.ok) throw new Error(String(response.status));
        const result = await readCappedText(response);
        if (!cancelled) setText(result);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    // One microtask later: the hook linter rejects a synchronous setState from
    // the effect body (same pattern as the other data-loading pages).
    Promise.resolve().then(() => void run());
    return () => {
      cancelled = true;
    };
  }, [attachment.url, kind]);

  const notice = (icon: string, message: string) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "0.75rem",
        padding: "3rem 1.5rem",
        textAlign: "center",
        color: "var(--text-secondary)",
        fontSize: "0.85rem",
      }}
    >
      <Icon name={icon} size="1.8rem" color="var(--text-muted)" />
      <span style={{ maxWidth: "46ch" }}>{message}</span>
      <a href={href} download={mediaDownloadName(attachment)} className="btn btn-outline btn-sm">
        <Icon name="download" /> {t.media_download}
      </a>
    </div>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${t.a11y_document_viewer}: ${name}`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(96vw, 1100px)",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "0.7rem 0.9rem",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-elevated)",
          }}
        >
          <Icon name={documentIcon(attachment.url)} size="1.4rem" />
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: "0.1rem" }}>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</strong>
            {details ? <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{details}</span> : null}
          </span>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-outline btn-sm"
              title={t.document_open_new_tab}
              aria-label={t.document_open_new_tab}
            >
              <Icon name="external-link" />
              <span className="hidden sm:inline">{t.document_open_new_tab}</span>
            </a>
            <a
              href={href}
              download={mediaDownloadName(attachment)}
              className="btn btn-outline btn-sm"
              title={t.media_download}
              aria-label={t.media_download}
            >
              <Icon name="download" />
            </a>
            <button ref={closeRef} type="button" onClick={onClose} className="btn btn-ghost btn-sm" aria-label={t.action_close}>
              <Icon name="times" />
            </button>
          </span>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: kind === "pdf" ? "var(--bg-overlay)" : "var(--bg-surface)" }}>
          {kind === "pdf" ? (
            <iframe
              src={href}
              title={name}
              style={{ width: "100%", height: "78vh", border: "none", background: "#fff", display: "block" }}
            />
          ) : kind === "text" ? (
            failed ? (
              notice("exclamation-triangle", t.document_preview_unavailable)
            ) : text === null ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", padding: "3rem 1rem", color: "var(--text-muted)", fontSize: "0.85rem" }}>
                <Icon name="hourglass" spin /> {t.loading}
              </div>
            ) : (
              <>
                {text.truncated ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                      padding: "0.5rem 0.9rem",
                      borderBottom: "1px solid var(--border)",
                      background: "var(--accent-bg)",
                      color: "var(--text-secondary)",
                      fontSize: "0.78rem",
                    }}
                  >
                    <Icon name="info-circle" size="0.85rem" />
                    {t.document_preview_truncated.replace("{size}", formatBytes(DOCUMENT_PREVIEW_MAX_BYTES))}
                  </div>
                ) : null}
                <pre
                  style={{
                    margin: 0,
                    padding: "1rem",
                    overflow: "auto",
                    maxHeight: "78vh",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                    fontSize: "0.82rem",
                    lineHeight: 1.5,
                    color: "var(--text-primary)",
                  }}
                >
                  {text.text}
                </pre>
              </>
            )
          ) : (
            notice("file-o", t.document_preview_unavailable)
          )}
        </div>
      </div>
    </div>
  );
}
