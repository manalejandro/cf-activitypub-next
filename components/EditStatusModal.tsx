"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { useEmojiAutocomplete, EmojiAutocompleteDropdown } from "@/components/EmojiAutocomplete";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Icon } from "@/components/Icon";
import type { Status, MediaAttachment } from "@/components/StatusCard";
import { MAX_MEDIA_ATTACHMENTS, MAX_POLL_OPTIONS, MAX_STATUS_CHARS } from "@/lib/constants";

/**
 * Shared "edit status" modal: edit the text, CW, media attachments (add /
 * remove) and poll. Sends `media_ids` and `poll` so the PUT route replaces
 * them.
 */
export function EditStatusModal({
  status,
  onClose,
  onSaved,
}: {
  status: Status | null;
  onClose: () => void;
  onSaved: (updated: Status) => void;
}) {
  const { t, locale } = useLocale();
  const token = getToken();
  const [text, setText] = useState("");
  const [spoiler, setSpoiler] = useState("");
  const [showCw, setShowCw] = useState(false);
  const [media, setMedia] = useState<MediaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pollMode, setPollMode] = useState(false);
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);
  const [pollExpiry, setPollExpiry] = useState(86400);
  const [pollMultiple, setPollMultiple] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const auto = useEmojiAutocomplete(text, setText, textareaRef);

  // Initialize the form when the modal opens or the status changes.
  useEffect(() => {
    if (!status) return;
    const div = typeof document !== "undefined" ? document.createElement("div") : null;
    if (div) {
      div.innerHTML = status.content.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText((div.textContent ?? div.innerText ?? "").trim());
    } else {
      setText(status.content.replace(/<[^>]*>/g, "").trim());
    }
    setSpoiler(status.spoiler_text ?? "");
    setShowCw(!!status.spoiler_text);
    setMedia(status.media_attachments ?? []);
    const poll = status.poll;
    setPollMode(!!poll);
    setPollOptions(poll && poll.options.length > 0 ? poll.options.map((o) => o.title) : ["", ""]);
    setPollMultiple(poll?.multiple ?? false);
    if (poll?.expires_at) {
      const remaining = Math.floor((new Date(poll.expires_at).getTime() - Date.now()) / 1000);
      setPollExpiry(Number.isFinite(remaining) && remaining >= 300 ? remaining : 86400);
    } else {
      setPollExpiry(86400);
    }
  }, [status]);

  if (!status) return null;
  const s = status;

  function insertEmoji(emoji: string) {
    setText((prev) => prev + emoji);
    setEmojiOpen(false);
    textareaRef.current?.focus();
  }

  async function handleSave() {
    if (!token || !text.trim() || busy) return;
    setBusy(true);
    try {
      const hasPoll = pollMode && pollOptions.filter((o) => o.trim()).length >= 2;
      const body: Record<string, unknown> = {
        status: text,
        spoiler_text: showCw ? spoiler : "",
        sensitive: !!spoiler && showCw,
        media_ids: media.map((m) => m.id),
      };
      if (hasPoll) {
        body.poll = {
          options: pollOptions.filter((o) => o.trim()),
          expires_in: pollExpiry,
          multiple: pollMultiple,
        };
      } else if (s.poll) {
        body.poll = null;
      }
      const res = await fetch(`/api/v1/statuses/${encodeURIComponent(s.id)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const updated = await res.json() as Status;
        onSaved(updated);
        onClose();
      }
    } catch { /* ignore */ }
    setBusy(false);
  }

  async function addFiles(files: FileList | null) {
    if (!files || !token || media.length >= MAX_MEDIA_ATTACHMENTS) return;
    for (const file of Array.from(files).slice(0, MAX_MEDIA_ATTACHMENTS - media.length)) {
      const form = new FormData();
      form.append("file", file);
      form.append("locale", locale);
      if (spoiler && showCw) form.append("sensitive", "true");
      try {
        const res = await fetch("/api/v1/media", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (res.ok) {
          const att = await res.json() as MediaAttachment;
          setMedia((prev) => [...prev, att]);
        }
      } catch { /* ignore */ }
    }
  }

  function removeMedia(id: string) {
    setMedia((prev) => prev.filter((m) => m.id !== id));
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.edit_status_title}
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "var(--bg)", borderRadius: "var(--radius-lg)", padding: "1.25rem", width: "min(640px, 95vw)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: "1rem" }}>{t.edit_status_title}</span>
          <button type="button" onClick={onClose} aria-label={t.action_close} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: "1.1rem", padding: "0.25rem" }}><Icon name="times" color="var(--text-muted)" /></button>
        </div>

        {showCw && (
          <input
            type="text"
            value={spoiler}
            onChange={(e) => setSpoiler(e.target.value)}
            placeholder={t.cw_placeholder}
            aria-label={t.cw_placeholder}
            className="input"
            style={{ width: "100%" }}
          />
        )}

        <div style={{ position: "relative" }}>
          <textarea
            autoFocus
            ref={textareaRef}
            value={text}
            onChange={auto.onChange}
            onKeyDown={auto.onKeyDown}
            placeholder={t.edit_status_placeholder}
            aria-label={t.edit_label}
            maxLength={MAX_STATUS_CHARS}
            className="input"
            style={{ resize: "none", minHeight: 120, fontFamily: "inherit", width: "100%" }}
          />
          <EmojiAutocompleteDropdown
            suggestions={auto.suggestions}
            activeIndex={auto.activeIndex}
            onSelect={auto.select}
          />
        </div>

        {/* Poll options */}
        {pollMode && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "0.75rem" }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.25rem" }}>{t.composer_poll_options}</div>
            {pollOptions.map((opt, i) => (
              <div key={i} style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
                <input
                  type="text"
                  className="input"
                  value={opt}
                  placeholder={t.composer_poll_option.replace("{number}", String(i + 1))}
                  aria-label={t.composer_poll_option.replace("{number}", String(i + 1))}
                  style={{ flex: 1 }}
                  onChange={(e) => setPollOptions((p) => p.map((o, j) => (j === i ? e.target.value : o)))}
                />
                {pollOptions.length > 2 && (
                  <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "0.25rem 0.4rem" }} onClick={() => setPollOptions((p) => p.filter((_, j) => j !== i))} aria-label={t.composer_poll_remove_option.replace("{number}", String(i + 1))}><Icon name="times" color="var(--danger)" /></button>
                )}
              </div>
            ))}
            {pollOptions.length < MAX_POLL_OPTIONS && (
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", fontSize: "0.8rem" }} onClick={() => setPollOptions((p) => [...p, ""])}>{t.composer_poll_add_option}</button>
            )}
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.25rem" }}>
              <select value={pollExpiry} onChange={(e) => setPollExpiry(Number(e.target.value))} className="btn btn-ghost btn-sm" style={{ fontSize: "0.78rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--text)" }}>
                <option value={300}>{t.composer_poll_5m}</option>
                <option value={3600}>{t.composer_poll_1h}</option>
                <option value={21600}>{t.composer_poll_6h}</option>
                <option value={86400}>{t.composer_poll_1d}</option>
                <option value={259200}>{t.composer_poll_3d}</option>
                <option value={604800}>{t.composer_poll_7d}</option>
              </select>
              <label style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.8rem", color: "var(--text-secondary)", cursor: "pointer" }}>
                <input type="checkbox" checked={pollMultiple} onChange={(e) => setPollMultiple(e.target.checked)} />
                {t.poll_multiple}
              </label>
            </div>
          </div>
        )}

        {/* Media management */}
        {media.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {media.map((m) => (
              <div key={m.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <div style={{ position: "relative", flexShrink: 0, width: 64, height: 64 }}>
                  {m.type === "image" || m.type === "gifv" ? (
                    <Image src={m.preview_url ?? m.url} alt={m.description ?? ""} width={64} height={64} style={{ objectFit: "cover", borderRadius: "var(--radius-sm)", filter: m.sensitive ? "blur(8px)" : undefined }} />
                  ) : (
                    <div style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.4rem" }}><Icon name={m.type === "audio" ? "music" : "film"} size="1.4rem" /></div>
                  )}
                </div>
                <span style={{ flex: 1, fontSize: "0.85rem", color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.description || m.type}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t.action_delete}
                  style={{ color: "var(--danger)", flexShrink: 0 }}
                  onClick={() => removeMedia(m.id)}
                >
                  <Icon name="trash" color="var(--danger)" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Toolbar: emoji, attach, CW, poll */}
        <div style={{ display: "flex", gap: "0.25rem", alignItems: "center", position: "relative", flexWrap: "wrap" }}>
          <div ref={emojiRef} style={{ position: "relative" }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: emojiOpen ? "var(--accent-bg)" : undefined }}
              onClick={() => setEmojiOpen((o) => !o)}
              title={t.composer_emoji}
              aria-label={t.composer_emoji}
              aria-haspopup="dialog"
              aria-expanded={emojiOpen}
            >
              <Icon name="smile-o" size="1rem" />
            </button>
            <EmojiPicker onInsert={insertEmoji} open={emojiOpen} onClose={() => setEmojiOpen(false)} anchorRef={emojiRef} />
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "1rem", padding: "0.3rem 0.5rem" }}
            onClick={() => fileRef.current?.click()}
            disabled={media.length >= 4 || pollMode || busy}
            title={t.compose_attach}
            aria-label={t.compose_attach}
          >
            <Icon name="paperclip" size="1rem" />
          </button>
          <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" multiple style={{ display: "none" }} onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: showCw ? "var(--accent-bg)" : undefined }}
            onClick={() => setShowCw((v) => !v)}
            title={t.cw_placeholder}
            aria-label={t.cw_placeholder}
            aria-pressed={showCw}
          >
            <Icon name="exclamation-triangle" size="1rem" />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: pollMode ? "var(--accent-bg)" : undefined }}
            onClick={() => setPollMode((v) => !v)}
            disabled={media.length > 0}
            title={t.composer_poll}
            aria-label={t.composer_poll}
            aria-pressed={pollMode}
          >
            <Icon name="bar-chart" size="1rem" />
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{text.length}/{MAX_STATUS_CHARS}</span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t.profile_cancel}</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim() || busy} onClick={() => void handleSave()}>
              {busy ? "…" : t.profile_save}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}