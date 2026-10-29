"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { useLocale, translateKey } from "@/lib/i18n";
import { useFocusTrap } from "@/components/useFocusTrap";
import { clipboardFiles } from "@/lib/clipboard-media";
import { getToken } from "@/lib/client-api";
import { useEmojiAutocomplete, EmojiAutocompleteDropdown } from "@/components/EmojiAutocomplete";
import { useAccountAutocomplete, AccountAutocompleteDropdown } from "@/components/AccountAutocomplete";
import { useTagAutocomplete, TagAutocompleteDropdown } from "@/components/TagAutocomplete";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Icon } from "@/components/Icon";
import type { Status, MediaAttachment } from "@/components/StatusCard";
import { useLimits } from "@/lib/limits-client";
import { mediaChipIcon, uploadMediaFiles } from "@/lib/media/upload-client";
import { MIN_POLL_OPTIONS } from "@/lib/constants";
import { POLL_DEFAULT_EXPIRATION } from "@/lib/constants";
import LocationPickerModal, { type GeoLocation } from "@/components/LocationPickerModal";
import { VisibilityPicker } from "@/components/VisibilityPicker";
import { LicensePicker } from "@/components/LicensePicker";
import { fetchLicenses } from "@/lib/license-client";
import { MAX_EVENT_NAME_CHARS, MAX_EVENT_LOCATION_CHARS, parseEventInput } from "@/lib/event";

/** ISO instant → `datetime-local` input value (local time). */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  const limits = useLimits();
  const token = getToken();
  const [text, setText] = useState("");
  const [spoiler, setSpoiler] = useState("");
  const [showCw, setShowCw] = useState(false);
  const [media, setMedia] = useState<MediaAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [pollMode, setPollMode] = useState(false);
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);
  const [pollExpiry, setPollExpiry] = useState(POLL_DEFAULT_EXPIRATION);
  const [pollMultiple, setPollMultiple] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "unlisted" | "private" | "direct">("public");
  // null = the stored license URI could not be resolved against the catalogue:
  // save then omits `license` (sending "" would silently drop a license whose
  // catalogue entry was removed — the status keeps its URI by design).
  const [licenseId, setLicenseId] = useState<string | null>("");
  const [location, setLocation] = useState<GeoLocation | null>(null);
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  // An ActivityStreams Event edits its event fields; the type never changes.
  const isEvent = status?.ap_type === "Event";
  const [eventName, setEventName] = useState("");
  const [eventStart, setEventStart] = useState("");
  const [eventEnd, setEventEnd] = useState("");
  const [eventVenue, setEventVenue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);
  const auto = useEmojiAutocomplete(text, setText, textareaRef);
  const accountAuto = useAccountAutocomplete(text, setText, textareaRef);
  const tagAuto = useTagAutocomplete(text, setText, textareaRef);

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
    const vis = status.visibility;
    setVisibility(vis === "unlisted" || vis === "private" || vis === "direct" ? vis : "public");
    setLocation(status.location ?? null);
    setLicenseId(status.license_url ? null : "");
    if (status.license_url) {
      // The picker works with catalogue ids: resolve the stored URI against the
      // catalogue so the current license shows selected and can be changed.
      void fetchLicenses().then((list) => {
        const match = list.find((l) => l.url === status.license_url);
        if (match) setLicenseId((prev) => (prev === null ? match.id : prev));
      });
    }
    if (status.ap_type === "Event") {
      const meta = status.ap_meta;
      setEventName(meta?.name ?? "");
      setEventStart(toLocalInput(meta?.startTime));
      setEventEnd(toLocalInput(meta?.endTime));
      setEventVenue(meta?.location ?? "");
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
    if (!token || busy) return;
    // An Event may be all title (no body text), like in the composer.
    if (!text.trim() && !(isEvent && eventName.trim())) return;
    setBusy(true);
    setSaveError(null);
    try {
      const hasPoll = pollMode && pollOptions.filter((o) => o.trim()).length >= MIN_POLL_OPTIONS;
      const body: Record<string, unknown> = {
        status: text,
        content_type: "text/markdown",
        spoiler_text: showCw ? spoiler : "",
        sensitive: !!spoiler && showCw,
        media_ids: media.map((m) => m.id),
        visibility,
        // Explicit null removes a stored location (the PUT treats a present
        // `location` as the new value).
        location: location ?? null,
      };
      if (licenseId !== null) body.license = licenseId;
      // An Event edit must ALWAYS carry the event: omitted, the PUT keeps the
      // stored copy (clearing the title here would silently remove nothing and
      // time edits would never travel), and `event: null` on an Event status is
      // refused server-side (it desyncs the raw document from the stored type).
      // Incomplete fields block the save with the composer's own errors —
      // validated through parseEventInput, the exact contract the PUT applies.
      if (isEvent) {
        const startDate = eventStart ? new Date(eventStart) : null;
        const endDate = eventEnd ? new Date(eventEnd) : null;
        const eventPayload = {
          name: eventName.trim(),
          start_time: startDate && !Number.isNaN(startDate.getTime()) ? startDate.toISOString() : "",
          end_time: endDate && !Number.isNaN(endDate.getTime()) ? endDate.toISOString() : null,
          location: eventVenue.trim(),
        };
        const eventResult = parseEventInput(eventPayload);
        if ("error" in eventResult) {
          setSaveError(translateKey(t, eventResult.error) ?? t.compose_error_event);
          setBusy(false);
          return;
        }
        body.event = eventPayload;
      }
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
      } else {
        // Surface the failure: a 401 (token retired mid-edit) or 422 (edit
        // rejected) used to leave the modal open with no feedback — the user
        // pressed Save and nothing visibly happened.
        let msg: string = t.network_error;
        try {
          const data = await res.json() as { error?: string; error_code?: string };
          msg = (data.error_code ? translateKey(t, data.error_code) : null) ?? data.error ?? t.network_error;
        } catch { /* non-JSON error body — keep the generic message */ }
        setSaveError(msg);
      }
    } catch { setSaveError(t.network_error); }
    setBusy(false);
  }

  async function addFiles(files: FileList | File[] | null) {
    const selected = files ? Array.from(files) : [];
    const remaining = limits.maxMediaAttachments - media.length;
    if (!token || uploading || selected.length === 0 || remaining <= 0) return;
    setUploadError(null);
    setUploading(true);
    try {
      const { attachments, error } = await uploadMediaFiles(selected, {
        token,
        locale,
        sensitive: Boolean(spoiler && showCw),
        remaining,
        maxAttachments: limits.maxMediaAttachments,
        limits,
        t,
      });
      setMedia((prev) => [...prev, ...attachments]);
      if (error) setUploadError(error);
    } finally {
      setUploading(false);
    }
  }

  function removeMedia(id: string) {
    setMedia((prev) => prev.filter((m) => m.id !== id));
  }

  return (
    <div
      ref={dialogRef}
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
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
            <input
              type="text"
              value={spoiler}
              onChange={(e) => setSpoiler(e.target.value)}
              placeholder={t.cw_placeholder}
              aria-label={t.cw_placeholder}
              maxLength={limits.maxCwChars}
              className="input"
              style={{ flex: 1 }}
            />
            <span style={{ fontSize: "0.75rem", color: spoiler.length > limits.maxCwChars - 20 ? "var(--danger)" : "var(--text-muted)", flexShrink: 0 }}>
              {spoiler.length}/{limits.maxCwChars}
            </span>
          </div>
        )}

        <div style={{ position: "relative" }}>
          <textarea
            autoFocus
            ref={textareaRef}
            value={text}
            onChange={(e) => { auto.onChange(e); accountAuto.onChange(e); tagAuto.onChange(e); }}
            onKeyDown={(e) => { auto.onKeyDown(e); accountAuto.onKeyDown(e); tagAuto.onKeyDown(e); }}
            onPaste={(e) => {
              const files = clipboardFiles(e);
              if (files.length > 0) void addFiles(files);
            }}
            placeholder={t.edit_status_placeholder}
            aria-label={t.edit_label}
            maxLength={limits.maxStatusChars}
            className="input"
            style={{ resize: "none", minHeight: 120, fontFamily: "inherit", width: "100%" }}
          />
          <EmojiAutocompleteDropdown
            suggestions={auto.suggestions}
            activeIndex={auto.activeIndex}
            onSelect={auto.select}
          />
          <AccountAutocompleteDropdown
            suggestions={accountAuto.suggestions}
            activeIndex={accountAuto.activeIndex}
            onSelect={accountAuto.select}
            loading={accountAuto.loading}
          />
          <TagAutocompleteDropdown
            suggestions={tagAuto.suggestions}
            activeIndex={tagAuto.activeIndex}
            onSelect={tagAuto.select}
            loading={tagAuto.loading}
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
            {pollOptions.length < limits.maxPollOptions && (
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

        {/* Event fields (ActivityStreams Event statuses): the type of the post
            never changes on edit, but its title, time range and venue do. */}
        {isEvent && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)" }}>{t.composer_event}</div>
            <input
              type="text"
              className="input"
              placeholder={t.composer_event_title_ph}
              aria-label={t.composer_event_title}
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              maxLength={MAX_EVENT_NAME_CHARS}
              style={{ fontSize: "0.9rem" }}
            />
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.78rem", color: "var(--text-secondary)", flex: "1 1 11rem" }}>
                {t.composer_event_start}
                <input
                  type="datetime-local"
                  className="input"
                  value={eventStart}
                  onChange={(e) => setEventStart(e.target.value)}
                  style={{ fontSize: "0.85rem" }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontSize: "0.78rem", color: "var(--text-secondary)", flex: "1 1 11rem" }}>
                {t.composer_event_end}
                <input
                  type="datetime-local"
                  className="input"
                  value={eventEnd}
                  onChange={(e) => setEventEnd(e.target.value)}
                  min={eventStart || undefined}
                  style={{ fontSize: "0.85rem" }}
                />
              </label>
            </div>
            <input
              type="text"
              className="input"
              placeholder={t.composer_event_location_ph}
              aria-label={t.composer_event_location}
              value={eventVenue}
              onChange={(e) => setEventVenue(e.target.value)}
              maxLength={MAX_EVENT_LOCATION_CHARS}
              style={{ fontSize: "0.9rem" }}
            />
          </div>
        )}

        {/* Media management */}
        {media.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {media.map((m) => (
              <div key={m.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <div style={{ position: "relative", flexShrink: 0, width: 64, height: 64 }}>
                  {m.type === "image" || m.type === "gifv" ? (
                    <Image src={m.preview_url ?? m.url ?? ""} alt={m.description ?? ""} width={64} height={64} style={{ objectFit: "cover", borderRadius: "var(--radius-sm)", filter: m.sensitive ? "blur(8px)" : undefined }} />
                  ) : (
                    <div style={{ width: 64, height: 64, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.4rem" }}><Icon name={mediaChipIcon(m)} size="1.4rem" /></div>
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
            {uploading && (
              <div style={{ width: 72, height: 72, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Icon name="hourglass" spin size="1.5rem" />
              </div>
            )}
          </div>
        )}
        {uploading && media.length === 0 && (
          <div style={{ width: 72, height: 72, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="hourglass" spin size="1.5rem" />
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
            disabled={media.length >= limits.maxMediaAttachments || pollMode || busy || uploading}
            title={t.composer_attach.replace("{value}", String(limits.maxMediaAttachments))}
            aria-label={t.composer_attach.replace("{value}", String(limits.maxMediaAttachments))}
          >
            {uploading ? <Icon name="hourglass" spin size="1rem" /> : <Icon name="paperclip" size="1rem" />}
          </button>
          <input ref={fileRef} type="file" accept="image/*,video/*,audio/*,application/pdf,text/plain,.pdf,.txt" multiple style={{ display: "none" }} onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
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
            disabled={media.length > 0 || isEvent}
            title={t.composer_poll}
            aria-label={t.composer_poll}
            aria-pressed={pollMode}
          >
            <Icon name="bar-chart" size="1rem" />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowLocationPicker(true)}
            title={t.location_title}
            aria-label={t.location_title}
            aria-pressed={Boolean(location)}
            style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: location ? "var(--accent-bg)" : undefined }}
          >
            <Icon name="map-marker" size="1rem" />
          </button>
        </div>

        {uploadError && (
          <p style={{ color: "var(--danger)", fontSize: "0.8rem", margin: 0 }}>{uploadError}</p>
        )}

        {saveError && (
          <p style={{ color: "var(--danger)", fontSize: "0.8rem", margin: 0 }} role="alert">{saveError}</p>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
            {/* Same pickers as the composer (everything but the scheduler: an
                edit publishes through the normal Update fan-out). */}
            <VisibilityPicker value={visibility} onChange={(v) => setVisibility(v)} direction="up" />
            <LicensePicker value={licenseId ?? ""} onChange={setLicenseId} direction="up" />
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>{text.length}/{limits.maxStatusChars}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t.profile_cancel}</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={(!text.trim() && !(isEvent && eventName.trim())) || busy} onClick={() => void handleSave()}>
              {busy ? "…" : t.profile_save}
            </button>
          </div>
        </div>

        {showLocationPicker && (
          <LocationPickerModal
            initial={location}
            onSave={(next) => { setLocation(next); setShowLocationPicker(false); }}
            onClose={() => setShowLocationPicker(false)}
          />
        )}
      </div>
    </div>
  );
}