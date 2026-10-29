"use client";

import { useState, useEffect, useRef, useCallback, useMemo, memo, type RefObject } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { PageLayout } from "@/components/PageLayout";
import { translateKey, useLocale } from "@/lib/i18n";
import { getToken } from "@/lib/client-api";
import { clipboardFiles } from "@/lib/clipboard-media";
import { mediaChipIcon, uploadMediaFiles } from "@/lib/media/upload-client";
import { useTimelineStream } from "@/lib/streaming/use-timeline-stream";
import { useTimelineCache } from "@/lib/streaming/use-timeline-cache";
import { purgeStatusFromCache, clearAllTimelineCaches, applyStatusInFeed } from "@/lib/streaming/timeline-cache";
import { useNewStatusesBuffer } from "@/lib/streaming/use-new-statuses";
import NewStatusesPill from "@/components/NewStatusesPill";
import { StatusCard } from "@/components/StatusCard";
import { EmojiPicker } from "@/components/EmojiPicker";
import { useEmojiAutocomplete, EmojiAutocompleteDropdown } from "@/components/EmojiAutocomplete";
import LocationPickerModal, { type GeoLocation } from "@/components/LocationPickerModal";
import { useAccountAutocomplete, AccountAutocompleteDropdown } from "@/components/AccountAutocomplete";
import { useTagAutocomplete, TagAutocompleteDropdown } from "@/components/TagAutocomplete";
import { EditStatusModal } from "@/components/EditStatusModal";
import { BackToTop } from "@/components/BackToTop";
import { Icon } from "@/components/Icon";
import { VisibilityPicker } from "@/components/VisibilityPicker";
import { LicensePicker } from "@/components/LicensePicker";
import { AnnouncementsBanner } from "@/components/AnnouncementsBanner";
import { useLimits } from "@/lib/limits-client";
import type { Status, Me, MediaAttachment } from "@/components/StatusCard";
import { MIN_POLL_OPTIONS } from "@/lib/constants";
import { MAX_EVENT_LOCATION_CHARS, MAX_EVENT_NAME_CHARS } from "@/lib/event";
import { POLL_DEFAULT_EXPIRATION } from "@/lib/constants";
import { Loading } from "@/components/Loading";

// Earliest allowed schedule time: now + 5 minutes. Computed on demand (when the
// picker opens) rather than at module load — the Worker isolate can live for
// days and a browser tab overnight, and a stale `min` would let the user pick a
// time already in the past (the server rejects it, but the input should not).
function computeScheduleMin(): string {
  const d = new Date(Date.now() + 5 * 60 * 1000);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** ISO instant → `datetime-local` input value (local time). */
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface HomeTimelineProps {
  statuses: Status[];
  me: Me | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
  onFav: (s: Status) => void;
  onReblog: (s: Status) => void;
  onEdit: (s: Status) => void;
  onDelete: (s: Status) => void;
}

/**
 * The feed itself, memoised. The composer lives in HomePage, so without this
 * every keystroke re-rendered every StatusCard and typing got slower as the
 * timeline grew. Every prop is stable across typing (the list only changes
 * when statuses change), and `useLocale`/`useRouter` are read here instead of
 * passed down so their identities can never break the memo.
 */
const HomeTimeline = memo(function HomeTimeline({
  statuses,
  me,
  loading,
  loadingMore,
  hasMore,
  bottomRef,
  onFav,
  onReblog,
  onEdit,
  onDelete,
}: HomeTimelineProps) {
  const { t } = useLocale();
  const router = useRouter();

  const handleReply = useCallback((status: Status) => {
    router.push(`/statuses/${encodeURIComponent(status.id)}?reply=1`);
  }, [router]);
  const handleQuote = useCallback((status: Status) => {
    router.push(`/statuses/${encodeURIComponent(status.id)}?quote=1`);
  }, [router]);

  if (loading) {
    return (
      <div className="flex flex-col gap-0">
        {[1, 2, 3].map((i) => (
          <div key={i} className="status-card flex gap-3" style={{ padding: "1rem" }}>
            <div className="skeleton" style={{ width: 42, height: 42, borderRadius: "50%", flexShrink: 0 }} />
            <div className="flex flex-col gap-2 flex-1">
              <div className="skeleton" style={{ height: 14, width: "40%" }} />
              <div className="skeleton" style={{ height: 14, width: "80%" }} />
              <div className="skeleton" style={{ height: 14, width: "60%" }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (statuses.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ padding: "4rem 2rem", color: "var(--text-muted)", textAlign: "center" }}
      >
        <span style={{ fontSize: "3rem", marginBottom: "1rem" }}><Icon name="globe" size="3rem" /></span>
        <p>{t.timeline_empty}</p>
        <p style={{ fontSize: "0.875rem" }}>{t.timeline_empty_sub}</p>
      </div>
    );
  }

  return (
    <>
      {statuses.map((s) => (
        <div key={s.id} data-status-id={s.id}>
          <StatusCard
            filterContext="home"
            status={s}
            onFav={onFav}
            onReblog={onReblog}
            onReply={handleReply}
            onQuote={handleQuote}
            me={me}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      ))}
      {/* Infinite scroll sentinel */}
      <div ref={bottomRef} style={{ padding: "1rem", textAlign: "center", color: "var(--text-muted)", fontSize: "0.82rem" }}>
        {loadingMore ? <Loading compact text={t.loading_more} /> : hasMore ? "" : t.timeline_end}
      </div>
    </>
  );
});

export default function HomePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [composing, setComposing] = useState("");
  const [posting, setPosting] = useState(false);
  const [mediaFiles, setMediaFiles] = useState<MediaAttachment[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [visibility, setVisibility] = useState<"public" | "unlisted" | "private" | "direct">("public");
  // FEP-6757: catalogue id of the license for this status ("" = no license).
  const [license, setLicense] = useState("");
  const [editingStatus, setEditingStatus] = useState<Status | null>(null);
  // Editing a scheduled post (/scheduled → "Edit" lands here with
  // ?edit_scheduled=<id>): the composer is prefilled from the stored params and
  // publishing becomes a PUT on the schedule instead of a new POST.
  const [editingScheduledId, setEditingScheduledId] = useState<string | null>(null);
  const [editingScheduledReplyId, setEditingScheduledReplyId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const mediaDescRefs = useRef<Record<string, string>>({});
  const { t, locale } = useLocale();
  const limits = useLimits();
  const emojiAuto = useEmojiAutocomplete(composing, setComposing, textareaRef);
  const accountAuto = useAccountAutocomplete(composing, setComposing, textareaRef);
  const tagAuto = useTagAutocomplete(composing, setComposing, textareaRef);

  const fetchPage = useCallback(async (maxId?: string) => {
    const url = maxId ? `/api/v1/timelines/home?max_id=${encodeURIComponent(maxId)}` : "/api/v1/timelines/home";
    const res = await fetch(url, { credentials: "include" });
    // Throw on failure: the cache hook keeps the current feed and retries later.
    if (!res.ok) throw new Error(`home timeline failed: ${res.status}`);
    const items = await res.json() as Status[];
    return { items, hasMore: items.length >= limits.defaultTimelinePage };
  }, [limits.defaultTimelinePage]);

  // Filled right after the buffer exists (the hook's background refetch
  // defers statuses into it when the reader is scrolled away).
  const bufferRef = useRef<{ queueItems: (items: Status[]) => void } | null>(null);
  const { statuses, setStatuses, loading, loadingMore, hasMore, seenIdsRef, loadMore, refresh, catchUp } = useTimelineCache("home", fetchPage, {
    refetchOnMount: true,
    onDeferredItems: (items) => bufferRef.current?.queueItems(items),
  });
  const { pendingCount, reveal, queueItems, handleStreamEvent } = useNewStatusesBuffer(setStatuses, seenIdsRef);
  useEffect(() => {
    bufferRef.current = { queueItems };
  }, [queueItems]);

  // Real-time home feed streaming
  useTimelineStream("user", (event, payload) => {
    if (handleStreamEvent(event, payload)) return;
    if (event === "filters_changed") {
      // Server filters changed: cached statuses embed the old `filtered`
      // results, so drop every cached feed and refetch with the new rules.
      clearAllTimelineCaches();
      void refresh();
    }
  }, { onReconnect: () => { void catchUp(); } });

  // Filters edited in the settings screen (same tab): refetch with new rules.
  useEffect(() => {
    const handler = () => { clearAllTimelineCaches(); void refresh(); };
    window.addEventListener("cf-ap:filters-changed", handler);
    return () => window.removeEventListener("cf-ap:filters-changed", handler);
  }, [refresh]);

  // CW compose state
  const [showCw, setShowCw] = useState(false);
  const [defaultSensitive, setDefaultSensitive] = useState(false);
  const [cwText, setCwText] = useState("");
  // Poll compose state
  const [pollMode, setPollMode] = useState(false);
  const [location, setLocation] = useState<GeoLocation | null>(null);
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollExpiry, setPollExpiry] = useState(POLL_DEFAULT_EXPIRATION);
  const [pollMultiple, setPollMultiple] = useState(false);
  // Scheduling state
  const [scheduling, setScheduling] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  // Recomputed each time the picker opens so `min` is never stale (see
  // computeScheduleMin).
  const scheduleMin = useMemo(computeScheduleMin, [scheduling]);
  // Event compose state (ActivityStreams Event): title + time range, with the
  // status text as the description.
  const [eventMode, setEventMode] = useState(false);
  const [eventName, setEventName] = useState("");
  const [eventStart, setEventStart] = useState("");
  const [eventEnd, setEventEnd] = useState("");
  const [eventLocation, setEventLocation] = useState("");

  // ?edit_scheduled=<id>: load the stored schedule into the composer (one-shot
  // at mount; the URL keeps the mode across a refresh). A missing/foreign id
  // drops back to a clean /home.
  useEffect(() => {
    const schedId = new URLSearchParams(window.location.search).get("edit_scheduled");
    if (!schedId) return;
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    fetch(`/api/v1/scheduled_statuses/${encodeURIComponent(schedId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { router.replace("/home"); return; }
        const data = (await res.json()) as {
          id: string;
          scheduled_at: string;
          params: Record<string, unknown>;
          media_attachments?: MediaAttachment[];
        };
        const p = data.params;
        setComposing(typeof p.status === "string" ? p.status : "");
        const spoiler = typeof p.spoiler_text === "string" ? p.spoiler_text : "";
        setCwText(spoiler);
        setShowCw(Boolean(spoiler) || p.sensitive === true || p.sensitive === "true");
        setVisibility(p.visibility === "unlisted" || p.visibility === "private" || p.visibility === "direct" ? p.visibility : "public");
        setLicense(typeof p.license === "string" ? p.license : "");
        const loc = p.location as GeoLocation | null | undefined;
        setLocation(
          loc && typeof loc === "object" && Number.isFinite(Number(loc.latitude)) && Number.isFinite(Number(loc.longitude))
            ? { name: typeof loc.name === "string" ? loc.name : null, latitude: Number(loc.latitude), longitude: Number(loc.longitude) }
            : null
        );
        const poll = p.poll as { options?: unknown[]; expires_in?: number; multiple?: boolean } | undefined;
        if (poll && Array.isArray(poll.options) && poll.options.length > 0) {
          setPollMode(true);
          setPollOptions(poll.options.map((o) => String(o)));
          if (Number.isFinite(Number(poll.expires_in))) setPollExpiry(Number(poll.expires_in));
          setPollMultiple(poll.multiple === true);
        }
        const ev = p.event as { name?: string; start_time?: string; end_time?: string | null; location?: string } | undefined;
        if (ev && typeof ev.name === "string" && ev.start_time) {
          setEventMode(true);
          setEventName(ev.name);
          setEventStart(toLocalInputValue(ev.start_time));
          setEventEnd(ev.end_time ? toLocalInputValue(ev.end_time) : "");
          setEventLocation(typeof ev.location === "string" ? ev.location : "");
        }
        setMediaFiles(Array.isArray(data.media_attachments) ? data.media_attachments : []);
        setEditingScheduledReplyId(typeof p.in_reply_to_id === "string" ? p.in_reply_to_id : null);
        setScheduling(true);
        setScheduledAt(toLocalInputValue(data.scheduled_at));
        setEditingScheduledId(data.id);
      })
      .catch(() => {
        if (!cancelled) router.replace("/home");
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Infinite scroll sentinel
  useEffect(() => {
    const el = bottomRef.current;
    if (!el || loadingMore || !hasMore) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) void loadMore(); },
      { rootMargin: "300px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loadingMore, statuses]);

  const closeEmoji = useCallback(() => setEmojiOpen(false), []);

  async function fetchMe() {
    const res = await fetch("/api/v1/accounts/verify_credentials", { credentials: "include" });
    if (res.ok) setMe(await res.json() as Me);
  }

  async function fetchPrefs() {
    const res = await fetch("/api/v1/preferences", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json() as Record<string, string | boolean | null>;
    // In scheduled-edit mode the prefill owns visibility/license: this fetch
    // resolves in parallel with it, and applying the account defaults
    // afterwards would silently rewrite e.g. a direct schedule to the default
    // visibility when the user saves without touching the picker.
    const editingScheduled = new URLSearchParams(window.location.search).has("edit_scheduled");
    if (!editingScheduled) {
      const vis = data["posting:default:visibility"];
      if (typeof vis === "string") setVisibility(vis as "public" | "unlisted" | "private" | "direct");
      // FEP-6757: the account's default license for new statuses ("" = none).
      const lic = data["posting:default:license"];
      if (typeof lic === "string") setLicense(lic);
    }
    // Mastodon: "always mark media as sensitive" → new attachments blur by default.
    if (data["posting:default:sensitive"] === true) setDefaultSensitive(true);
  }

  useEffect(() => {
    const token = getToken();
    if (!token) { router.push("/login"); return; }
    Promise.resolve().then(() => void fetchMe());
    Promise.resolve().then(() => void fetchPrefs());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePost(e: React.FormEvent) {
    e.preventDefault();
    if (uploadingMedia) return;
    const hasPoll = pollMode && pollOptions.filter((o) => o.trim()).length >= MIN_POLL_OPTIONS;
    const hasEvent = eventMode && eventName.trim() !== "" && eventStart !== "" && (!eventEnd || new Date(eventEnd) >= new Date(eventStart));
    if (!composing.trim() && mediaFiles.length === 0 && !hasPoll && !hasEvent) return;
    setPosting(true);
    setEmojiOpen(false);
    const body: Record<string, unknown> = {
      status: composing,
      content_type: "text/markdown",
      media_ids: mediaFiles.map((f) => f.id),
      visibility,
      sensitive: showCw,
      spoiler_text: showCw ? cwText : "",
      language: locale,
      license,
    };
    if (scheduling && scheduledAt) {
      body.scheduled_at = new Date(scheduledAt).toISOString();
    }
    if (location) {
      body.location = location;
    }
    if (hasPoll) {
      body.poll = {
        options: pollOptions.filter((o) => o.trim()),
        expires_in: pollExpiry,
        multiple: pollMultiple,
      };
    }
    if (hasEvent) {
      // `datetime-local` values are local time; the API stores UTC instants.
      body.event = {
        name: eventName.trim(),
        start_time: new Date(eventStart).toISOString(),
        end_time: eventEnd ? new Date(eventEnd).toISOString() : null,
        location: eventLocation.trim(),
      };
    }
    // Flush any pending media descriptions before posting
    if (mediaFiles.length > 0) {
      await Promise.all(mediaFiles.map(async (f) => {
        const desc = mediaDescRefs.current[f.id];
        if (desc !== undefined) {
          await fetch(`/api/v1/media/${f.id}`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: desc.trim() || null }),
          });
        }
      }));
    }
    setError(null);
    try {
      // Editing an existing scheduled post: a PUT on the schedule row (same
      // body shape the create path stores), never a new POST — posting would
      // create a duplicate and leave the old schedule armed.
      if (editingScheduledId) {
        if (!scheduledAt) {
          setError(t.scheduled_error_past);
          setPosting(false);
          return;
        }
        body.scheduled_at = new Date(scheduledAt).toISOString();
        if (editingScheduledReplyId) body.in_reply_to_id = editingScheduledReplyId;
        const putRes = await fetch(`/api/v1/scheduled_statuses/${encodeURIComponent(editingScheduledId)}`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (putRes.ok) {
          setPosting(false);
          router.push("/scheduled");
          return;
        }
        const putData = (await putRes.json().catch(() => null)) as { error?: string; error_code?: string } | null;
        setError(translateKey(t, putData?.error_code, putData?.error) ?? t.network_error);
        setPosting(false);
        return;
      }
      const res = await fetch("/api/v1/statuses", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        if (data && data.scheduled_at) {
          setPosting(false);
          router.push("/scheduled");
          return;
        }
        setComposing("");
        setMediaFiles([]);
        mediaDescRefs.current = {};
        setShowCw(false);
        setCwText("");
        setPollMode(false);
        setPollOptions(["", ""]);
        setPollMultiple(false);
        setEventMode(false);
        setEventName("");
        setEventStart("");
        setEventEnd("");
        setEventLocation("");
        await refresh();
      } else {
        const data = await res.json().catch(() => null) as { error?: string; error_code?: string } | null;
        setError(translateKey(t, data?.error_code, data?.error ?? t.error_network) ?? t.error_network);
      }
    } catch {
      setError(t.error_network);
    }
    setPosting(false);
  }

  const insertEmoji = useCallback((emoji: string) => {
    const ta = textareaRef.current;
    if (!ta) { setComposing((c) => c + emoji); return; }
    const start = ta.selectionStart ?? composing.length;
    const end = ta.selectionEnd ?? composing.length;
    const next = composing.slice(0, start) + emoji + composing.slice(end);
    setComposing(next);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(start + emoji.length, start + emoji.length); }, 0);
  }, [composing]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadFiles(selected);
  }

  /** Upload files from the picker or the clipboard (paste in the composer). */
  async function uploadFiles(selected: File[]) {
    const token = getToken();
    const remaining = limits.maxMediaAttachments - mediaFiles.length;
    if (!token || selected.length === 0 || remaining <= 0) return;
    setError(null);
    setUploadingMedia(true);
    const { attachments, error: uploadError } = await uploadMediaFiles(selected, {
      token,
      locale,
      // CW on, or the "mark media as sensitive" preference → media blurred by default
      sensitive: showCw || defaultSensitive,
      remaining,
      maxAttachments: limits.maxMediaAttachments,
      limits,
      t,
    });
    setMediaFiles((prev) => [...prev, ...attachments]);
    if (uploadError) setError(uploadError);
    setUploadingMedia(false);
  }

  async function updateMediaDesc(id: string, description: string, setter: React.Dispatch<React.SetStateAction<MediaAttachment[]>>) {
    await fetch(`/api/v1/media/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: description.trim() || null }),
    });
    setter((prev) => prev.map((f) => f.id === id ? { ...f, description: description.trim() || null } : f));
  }

  async function toggleMediaSensitive(id: string) {
    const target = mediaFiles.find((f) => f.id === id);
    if (!target) return;
    const next = !target.sensitive;
    await fetch(`/api/v1/media/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sensitive: next }),
    });
    setMediaFiles((prev) => prev.map((f) => f.id === id ? { ...f, sensitive: next } : f));
  }

  const handleFav = useCallback((updated: Status) => {
    setStatuses((prev) => prev.map((x) => applyStatusInFeed(x, updated)));
  }, [setStatuses]);

  const handleReblog = useCallback((updated: Status) => {
    setStatuses((prev) => prev.map((x) => applyStatusInFeed(x, updated)));
  }, [setStatuses]);

  const openEdit = useCallback((s: Status) => {
    setEditingStatus(s);
  }, []);

  const handleStatusSaved = useCallback((updated: Status) => {
    setStatuses((prev) => prev.map((x) => applyStatusInFeed(x, updated)));
  }, [setStatuses]);

  const handleDelete = useCallback(async (s: Status) => {
    if (!confirm(t.status_delete_confirm)) return;
    const res = await fetch(`/api/v1/statuses/${s.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      setStatuses((prev) => prev.filter((x) => x.id !== s.id));
      purgeStatusFromCache(s.id);
    }
  }, [t, setStatuses]);

  return (
    <>
    <PageLayout sidebar={<Sidebar me={me} currentPath="/home" />}>

      {/* Main feed */}
        <AnnouncementsBanner />
        {/* Compose */}
        <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)" }}>
          <form onSubmit={handlePost} className="flex flex-col gap-3">
            {/* Editing a scheduled post: the composer is prefilled and the
                submit becomes a PUT on the schedule (see handlePost). */}
            {editingScheduledId && (
              <div
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem",
                  padding: "0.5rem 0.75rem", borderRadius: "var(--radius)",
                  background: "var(--accent-bg)", border: "1px solid var(--border)",
                  fontSize: "0.85rem", color: "var(--text-secondary)",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
                  <Icon name="clock-o" /> {t.scheduled_editing}
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { window.location.href = "/home"; }}>
                  {t.profile_cancel}
                </button>
              </div>
            )}
            {/* CW input */}
            {showCw && (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  className="input"
                  placeholder={`${t.cw_placeholder}…`}
                  aria-label={t.cw_placeholder}
                  value={cwText}
                  onChange={(e) => setCwText(e.target.value)}
                  maxLength={limits.maxCwChars}
                  style={{ fontSize: "0.9rem", flex: 1 }}
                />
                <span style={{ fontSize: "0.75rem", color: cwText.length > limits.maxCwChars - 20 ? "var(--danger)" : "var(--text-muted)", flexShrink: 0 }}>
                  {cwText.length}/{limits.maxCwChars}
                </span>
              </div>
            )}
            {/* Textarea */}
            <div style={{ position: "relative" }}>
              <textarea
                ref={textareaRef}
                className="input"
                style={{ resize: "vertical", minHeight: 80, fontFamily: "inherit" }}
                placeholder={t.compose_placeholder}
                aria-label={t.compose_label}
                value={composing}
                onChange={(e) => { emojiAuto.onChange(e); accountAuto.onChange(e); tagAuto.onChange(e); }}
                onKeyDown={(e) => { emojiAuto.onKeyDown(e); accountAuto.onKeyDown(e); tagAuto.onKeyDown(e); }}
                onPaste={(e) => {
                  const files = clipboardFiles(e);
                  if (files.length > 0) void uploadFiles(files);
                }}
                maxLength={limits.maxStatusChars}
              />
              <EmojiAutocompleteDropdown
                suggestions={emojiAuto.suggestions}
                activeIndex={emojiAuto.activeIndex}
                onSelect={emojiAuto.select}
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
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", padding: "0.75rem", background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "0.25rem" }}>{t.composer_poll_options}</div>
                {pollOptions.map((opt, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                    <input
                      type="text"
                      className="input"
                      placeholder={t.composer_poll_option.replace("{number}", String(i + 1))}
                      aria-label={t.composer_poll_option.replace("{number}", String(i + 1))}
                      value={opt}
                      onChange={(e) => setPollOptions((p) => p.map((o, j) => j === i ? e.target.value : o))}
                      maxLength={limits.maxPollOptionChars}
                      style={{ flex: 1, fontSize: "0.875rem" }}
                    />
                    {pollOptions.length > 2 && (
                      <button type="button" className="btn btn-ghost btn-sm" style={{ color: "var(--danger)", padding: "0.25rem 0.4rem" }} onClick={() => setPollOptions((p) => p.filter((_, j) => j !== i))} aria-label={t.composer_poll_remove_option.replace("{number}", String(i + 1))}><Icon name="times" color="var(--danger)" /></button>
                    )}
                  </div>
                ))}
                {pollOptions.length < limits.maxPollOptions && (
                  <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start", fontSize: "0.8rem" }} onClick={() => setPollOptions((p) => [...p, ""])}>{t.composer_poll_add_option}</button>
                )}
                <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                  <select value={pollExpiry} onChange={(e) => setPollExpiry(Number(e.target.value))} className="btn btn-ghost btn-sm" style={{ fontSize: "0.78rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--bg)", color: "var(--text)" }}>
                    <option value={300}>{t.composer_poll_5m}</option>
                    <option value={3600}>{t.composer_poll_1h}</option>
                    <option value={21600}>{t.composer_poll_6h}</option>
                    <option value={86400}>{t.composer_poll_1d}</option>
                    <option value={259200}>{t.composer_poll_3d}</option>
                    <option value={604800}>{t.composer_poll_7d}</option>
                  </select>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", cursor: "pointer" }}>
                    <input type="checkbox" checked={pollMultiple} onChange={(e) => setPollMultiple(e.target.checked)} />
                    {t.poll_multiple}
                  </label>
                </div>
              </div>
            )}

            {/* Event (ActivityStreams Event) */}
            {eventMode && (
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
                  value={eventLocation}
                  onChange={(e) => setEventLocation(e.target.value)}
                  maxLength={MAX_EVENT_LOCATION_CHARS}
                  style={{ fontSize: "0.85rem" }}
                />
              </div>
            )}

            {/* Schedule picker */}
            {scheduling && (
              <input
                type="datetime-local"
                className="input"
                aria-label={t.composer_schedule}
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                min={scheduleMin}
                style={{ fontSize: "0.85rem", width: "100%" }}
              />
            )}

            {/* Media previews */}
            {mediaFiles.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {mediaFiles.map((f) => (
                  <div key={f.id} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                    <div style={{ position: "relative", flexShrink: 0, width: 72, height: 72 }}>
                      {f.type === "image" || f.type === "gifv" ? (
                        <Image src={f.preview_url ?? f.url ?? ""} alt={f.description ?? ""} width={72} height={72} style={{ objectFit: "cover", borderRadius: "var(--radius-sm)", filter: f.sensitive ? "blur(8px)" : undefined }} />
                      ) : (
                        <div style={{ width: 72, height: 72, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem" }}><Icon name={mediaChipIcon(f)} size="1.5rem" /></div>
                      )}
                      <button type="button" onClick={() => setMediaFiles((prev) => prev.filter((x) => x.id !== f.id))}
                        aria-label={t.action_delete}
                        style={{ position: "absolute", top: 2, right: 2, background: "rgba(0,0,0,0.65)", color: "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: "0.65rem", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name="times" color="#fff" /></button>
                      <button
                        type="button"
                        onClick={() => void toggleMediaSensitive(f.id)}
                        aria-pressed={!!f.sensitive}
                        title={t.media_sensitive_toggle}
                        style={{ position: "absolute", bottom: 2, left: 2, background: "rgba(0,0,0,0.65)", color: f.sensitive ? "var(--warning)" : "#fff", border: "none", borderRadius: "50%", width: 18, height: 18, cursor: "pointer", fontSize: "0.65rem", display: "flex", alignItems: "center", justifyContent: "center" }}><Icon name={f.sensitive ? "eye-slash" : "eye"} color={f.sensitive ? "var(--warning)" : "#fff"} /></button>
                    </div>
                    <input
                      type="text"
                      placeholder={`${t.media_alt_text}…`}
                      aria-label={t.media_alt_text}
                      defaultValue={f.description ?? ""}
                      maxLength={limits.maxAltTextChars}
                      onChange={(e) => { mediaDescRefs.current[f.id] = e.target.value; }}
                      onBlur={(e) => void updateMediaDesc(f.id, e.target.value, setMediaFiles)}
                      style={{ flex: 1, padding: "0.35rem 0.6rem", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text)", fontSize: "0.82rem", fontFamily: "inherit" }}
                    />
                  </div>
                ))}
                {uploadingMedia && (
                  <div style={{ width: 72, height: 72, borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.5rem" }}><Icon name="hourglass" spin size="1.5rem" /></div>
                )}
              </div>
            )}

            {error && <div style={{ color: "var(--danger)", fontSize: "0.82rem" }}>{error}</div>}

            {/* Toolbar + counter + submit */}
            <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
              <div style={{ display: "flex", gap: "0.25rem", alignItems: "center", position: "relative", flexWrap: "wrap" }}>
                {/* Emoji button + picker */}
                <div ref={emojiRef} style={{ position: "relative" }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: "1.15rem", padding: "0.3rem 0.5rem", background: emojiOpen ? "var(--accent-bg)" : undefined }}
                    onClick={() => setEmojiOpen((o) => !o)}
                    title={t.composer_emoji}
                    aria-label={t.composer_emoji}
                    aria-haspopup="dialog"
                    aria-expanded={emojiOpen}
                  >
                    <Icon name="smile-o" size="1.15rem" />
                  </button>
                  <EmojiPicker
                    onInsert={insertEmoji}
                    open={emojiOpen}
                    onClose={closeEmoji}
                    anchorRef={emojiRef}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1.15rem", padding: "0.3rem 0.5rem" }}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={mediaFiles.length >= limits.maxMediaAttachments || uploadingMedia}
                  title={t.composer_attach.replace("{value}", String(limits.maxMediaAttachments))}
                  aria-label={t.composer_attach.replace("{value}", String(limits.maxMediaAttachments))}
                >
                  {uploadingMedia ? <Icon name="hourglass" spin size="1.15rem" /> : <Icon name="paperclip" size="1.15rem" />}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*,audio/*,application/pdf,text/plain,.pdf,.txt"
                  multiple
                  style={{ display: "none" }}
                  onChange={handleFileChange}
                />
                {/* CW button */}
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
                {/* Poll button */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: pollMode ? "var(--accent-bg)" : undefined }}
                  onClick={() => setPollMode((v) => { if (!v) setEventMode(false); return !v; })}
                  disabled={mediaFiles.length > 0}
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
                {/* Event button (ActivityStreams Event) */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: eventMode ? "var(--accent-bg)" : undefined }}
                  onClick={() => setEventMode((v) => { if (!v) setPollMode(false); return !v; })}
                  title={t.composer_event}
                  aria-label={t.composer_event}
                  aria-pressed={eventMode}
                >
                  <Icon name="calendar" size="1rem" />
                </button>
                {/* Schedule button */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: "1rem", padding: "0.3rem 0.5rem", background: scheduling ? "var(--accent-bg)" : undefined }}
                  onClick={() => setScheduling((v) => !v)}
                  disabled={Boolean(editingScheduledId)}
                  title={t.composer_schedule}
                  aria-label={t.composer_schedule}
                  aria-pressed={scheduling}
                >
                  <Icon name="clock-o" size="1rem" />
                </button>
                {/* Visibility selector */}
                <VisibilityPicker value={visibility} onChange={(v) => setVisibility(v)} />
                {/* License selector (FEP-6757) */}
                <LicensePicker value={license} onChange={setLicense} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <span style={{ fontSize: "0.8rem", color: composing.length > limits.maxStatusChars - 50 ? "var(--danger)" : "var(--text-muted)" }}>
                  {composing.length}/{limits.maxStatusChars}
                </span>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={posting || uploadingMedia || (!composing.trim() && mediaFiles.length === 0 && !(pollMode && pollOptions.filter((o) => o.trim()).length >= MIN_POLL_OPTIONS) && !(eventMode && eventName.trim() !== "" && eventStart !== "" && (!eventEnd || new Date(eventEnd) >= new Date(eventStart))))}
                >
                  {posting ? t.compose_posting : uploadingMedia ? <Icon name="hourglass" spin color="#fff" /> : t.compose_post}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Timeline */}
        <NewStatusesPill count={pendingCount} onClick={reveal} />
        <HomeTimeline
          statuses={statuses}
          me={me}
          loading={loading}
          loadingMore={loadingMore}
          hasMore={hasMore}
          bottomRef={bottomRef}
          onFav={handleFav}
          onReblog={handleReblog}
          onEdit={openEdit}
          onDelete={handleDelete}
        />
      </PageLayout>

      <BackToTop />
      {/* Edit status modal */}
      {showLocationPicker && (
        <LocationPickerModal
          initial={location}
          onSave={(next) => { setLocation(next); setShowLocationPicker(false); }}
          onClose={() => setShowLocationPicker(false)}
        />
      )}
      <EditStatusModal status={editingStatus} onClose={() => setEditingStatus(null)} onSaved={handleStatusSaved} />
    </>
  );
}
