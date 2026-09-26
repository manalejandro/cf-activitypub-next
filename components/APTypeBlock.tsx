"use client";

import Link from "next/link";
import Image from "next/image";
import { useLocale, type Translations } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { MediaPlayer } from "@/components/MediaPlayer";

/**
 * ActivityStreams type-specific renderer.
 * Given the underlying `ap_type` of a status plus its extracted `ap_meta`,
 * renders a contextual block: Event card, Place card, Article/Page header,
 * embedded top-level media, and a subtle type badge for non-Note objects.
 */

export interface APMeta {
  name?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  duration?: number | null;
  location?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  url?: string | null;
  mediaUrl?: string | null;
  imageUrl?: string | null;
  subject?: string | null;
  relationshipObject?: string | null;
  relationship?: string | null;
  formerType?: string | null;
  deleted?: string | null;
  totalItems?: number | null;
  describes?: string | null;
}

export interface APBlockMedia {
  id: string;
  type: string;
  url: string;
  preview_url?: string | null;
  description?: string | null;
}

// Maps an ActivityStreams type to its i18n dictionary key. Note is omitted
// because it never renders a badge; unknown types fall back to the raw type.
const TYPE_LABEL_KEYS: Record<string, keyof Translations> = {
  Article: "ap_type_article",
  Audio: "ap_type_audio",
  Collection: "ap_type_collection",
  Document: "ap_type_document",
  Event: "ap_type_event",
  Image: "ap_type_image",
  OrderedCollection: "ap_type_collection",
  Page: "ap_type_page",
  Place: "ap_type_place",
  Profile: "ap_type_profile",
  Relationship: "ap_type_relationship",
  Tombstone: "ap_type_tombstone",
  Video: "ap_type_video",
  Question: "ap_type_question",
  Note: "ap_type_note",
  PublicMessage: "ap_type_public_message",
};

function typeLabel(t: Translations, apType: string): string {
  const key = TYPE_LABEL_KEYS[apType];
  return key ? t[key] : apType;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function badgeStyle() {
  return {
    display: "inline-block",
    fontSize: "0.68rem",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    color: "var(--accent)",
    background: "var(--accent-bg)",
    border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
    borderRadius: "999px",
    padding: "0.1rem 0.5rem",
    marginBottom: "0.35rem",
  };
}

function cardStyle() {
  return {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    background: "var(--bg-elevated)",
    padding: "0.75rem 0.875rem",
    marginTop: "0.6rem",
    display: "flex" as const,
    flexDirection: "column" as const,
    gap: "0.35rem",
  };
}

function isMediaUrl(url: string): boolean {
  return /\.(mp4|webm|ogg|ogv|mov|m4v|mp3|oga|wav|flac|m4a|jpg|jpeg|png|gif|webp|bmp|avif)(#|\?|$)/i.test(url);
}

export function TypeBadge({ apType }: { apType?: string | null }) {
  const { t } = useLocale();
  if (!apType || apType === "Note") return null;
  return <span style={badgeStyle()}>{typeLabel(t, apType)}</span>;
}

export function APTypeBlock({
  apType,
  apMeta,
  mediaAttachments = [],
}: {
  apType?: string | null;
  apMeta?: APMeta | null;
  mediaAttachments?: APBlockMedia[];
}) {
  const { t } = useLocale();
  if (!apType || apType === "Note") return null;

  // ── Event ────────────────────────────────────────────────────────────────
  if (apType === "Event") {
    const start = formatDateTime(apMeta?.startTime);
    const end = formatDateTime(apMeta?.endTime);
    const title = apMeta?.name;
    return (
      <div style={cardStyle()}>
        {title && (
          <span style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)" }}><Icon name="calendar" /> {title}</span>
        )}
        {start && <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}><Icon name="clock-o" /> {start}{end ? ` → ${end}` : ""}</span>}
        {apMeta?.location && <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}><Icon name="map-marker" /> {apMeta.location}</span>}
        {apMeta?.duration && (
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }} className="flex items-center gap-1">
            <Icon name="hourglass-o" /> {formatDuration(apMeta.duration)}
          </span>
        )}
        {apMeta?.url && <Link href={apMeta.url} target="_blank" rel="nofollow noopener noreferrer" style={{ fontSize: "0.85rem", color: "var(--accent)", textDecoration: "none" }}>{t.ap_open_event}</Link>}
      </div>
    );
  }

  // ── Place ────────────────────────────────────────────────────────────────
  if (apType === "Place") {
    const hasCoords = apMeta?.latitude != null && apMeta?.longitude != null;
    const mapsUrl = hasCoords
      ? `https://www.openstreetmap.org/?mlat=${apMeta!.latitude}&mlon=${apMeta!.longitude}#map=16/${apMeta!.latitude}/${apMeta!.longitude}`
      : undefined;
    return (
      <div style={cardStyle()}>
        <span style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)" }}><Icon name="map-marker" /> {apMeta?.name ?? t.ap_type_place}</span>
        {hasCoords && (
          <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{apMeta!.latitude!.toFixed(5)}, {apMeta!.longitude!.toFixed(5)}</span>
        )}
        {mapsUrl && (
          <Link href={mapsUrl} target="_blank" rel="nofollow noopener noreferrer" style={{ fontSize: "0.85rem", color: "var(--accent)", textDecoration: "none" }}>{t.ap_view_map}</Link>
        )}
        {apMeta?.url && !mapsUrl && (
          <Link href={apMeta.url} target="_blank" rel="nofollow noopener noreferrer" style={{ fontSize: "0.85rem", color: "var(--accent)", textDecoration: "none" }}>{t.ap_open_place}</Link>
        )}
      </div>
    );
  }

  // ── Article / Page / Document: title header + original link ────────────
  if (apType === "Article" || apType === "Page" || apType === "Document") {
    const title = apMeta?.name;
    const target = apMeta?.url;
    let hostname: string | null = null;
    if (target) {
      try { hostname = new URL(target).hostname; } catch { /* ignore */ }
    }
    if (!title && !target) return null;
    return (
      <header style={{ marginBottom: "0.15rem" }}>
        {title && (
          <span style={{ display: "block", fontWeight: 650, fontSize: "1.05rem", lineHeight: 1.35, color: "var(--text)" }}>
            {title}
          </span>
        )}
        {target && (
          <div style={{ marginTop: title ? "0.15rem" : 0, display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
            <Link
              href={target}
              target="_blank"
              rel="nofollow noopener noreferrer"
              style={{ fontSize: "0.8rem", color: "var(--accent)", textDecoration: "none", wordBreak: "break-all", minWidth: 0 }}
            >
              {title ? t.ap_open_original : target}
            </Link>
            {hostname && <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>· {hostname}</span>}
          </div>
        )}
      </header>
    );
  }

  // ── Profile: describes an actor/entity ──────────────────────────────────
  if (apType === "Profile") {
    const name = apMeta?.name;
    const target = apMeta?.url;
    const describes = apMeta?.describes;
    const href = target ?? describes ?? null;
    if (!name && !href) return null;
    return (
      <div style={cardStyle()}>
        <span style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)" }}><Icon name="user" /> {name ?? t.ap_type_profile}</span>
        {href && (
          <Link href={href} target="_blank" rel="nofollow noopener noreferrer" style={{ fontSize: "0.85rem", color: "var(--accent)", textDecoration: "none", wordBreak: "break-all" }}>
            {href}
          </Link>
        )}
      </div>
    );
  }

  // ── Relationship: subject — relationship → object ───────────────────────
  if (apType === "Relationship") {
    const subject = apMeta?.subject;
    const relationship = apMeta?.relationship;
    const object = apMeta?.relationshipObject;
    if (!subject && !relationship && !object) return null;
    return (
      <div style={cardStyle()}>
        <span style={{ fontSize: "0.9rem", color: "var(--text)", wordBreak: "break-all" }}>
          {[subject, relationship, object].filter(Boolean).join("  →  ")}
        </span>
      </div>
    );
  }

  // ── Tombstone: a deleted object ─────────────────────────────────────────
  if (apType === "Tombstone") {
    const formerType = apMeta?.formerType ?? t.ap_type_tombstone;
    const deleted = apMeta?.deleted ? formatDateTime(apMeta.deleted) : null;
    return (
      <div style={cardStyle()}>
        <span style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>
          <Icon name="trash" /> {t.ap_tombstone_deleted} {formerType}{deleted ? ` · ${deleted}` : ""}
        </span>
      </div>
    );
  }

  // ── Collection / OrderedCollection ──────────────────────────────────────
  if (apType === "Collection" || apType === "OrderedCollection") {
    const name = apMeta?.name;
    const totalItems = apMeta?.totalItems;
    const target = apMeta?.url;
    return (
      <div style={cardStyle()}>
        <span style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)" }}>
          <Icon name="book" /> {name ?? t.ap_type_collection}{totalItems != null ? ` · ${totalItems}` : ""}
        </span>
        {target && (
          <Link href={target} target="_blank" rel="nofollow noopener noreferrer" style={{ fontSize: "0.85rem", color: "var(--accent)", textDecoration: "none", wordBreak: "break-all" }}>
            {target}
          </Link>
        )}
      </div>
    );
  }

  // ── Question: polls are rendered by PollView; fall back to the question
  //    text + link for bare questions without stored poll options ─────────
  if (apType === "Question") {
    const name = apMeta?.name;
    const target = apMeta?.url;
    if (!name && !target) return null;
    return (
      <div style={cardStyle()}>
        {name && <span style={{ fontWeight: 600, fontSize: "0.95rem", color: "var(--text)" }}><Icon name="question-circle" /> {name}</span>}
        {target && (
          <Link href={target} target="_blank" rel="nofollow noopener noreferrer" style={{ fontSize: "0.85rem", color: "var(--accent)", textDecoration: "none", wordBreak: "break-all" }}>
            {t.ap_open_original}
          </Link>
        )}
      </div>
    );
  }

  // ── Top-level media (Audio / Video / Image objects with no attachments) ─
  if (apType === "Audio" || apType === "Video" || apType === "Image") {
    if (mediaAttachments.length > 0) return null; // rendered by MediaGrid
    // Prefer the direct media file (mediaUrl) — watch pages like PeerTube's
    // `…/w/…` are stored in `url`. Fall back to `url` only when it is itself
    // a media file.
    const meta = apMeta;
    const src = meta?.mediaUrl
      ? meta.mediaUrl
      : meta?.url && isMediaUrl(meta.url)
        ? meta.url
        : null;
    const page = meta?.url;
    const pageIsMedia = !!src && page === src;
    const pageHost: string | null = page && !pageIsMedia ? (() => { try { return new URL(page).hostname; } catch { return null; } })() : null;
    if (!src && !page) return null;
    return (
      <div style={{ marginTop: "0.6rem" }}>
        {src && apType === "Image" && (
          <div style={{ borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border)" }}>
            <Image src={src} alt={meta?.name ?? ""} width={640} height={360} style={{ width: "100%", objectFit: "cover" }} />
          </div>
        )}
        {src && apType === "Video" && (
          <div style={{ borderRadius: "var(--radius)", overflow: "hidden", maxHeight: 420 }}>
            <MediaPlayer src={src} kind="video" variant="inline" poster={meta?.imageUrl ?? undefined} description={meta?.name} />
          </div>
        )}
        {src && apType === "Audio" && (
          <MediaPlayer src={src} kind="audio" variant="inline" description={meta?.name} />
        )}
        {page && !pageIsMedia && (
          <div style={{ marginTop: "0.35rem", display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
            <Link
              href={page}
              target="_blank"
              rel="nofollow noopener noreferrer"
              style={{ fontSize: "0.8rem", color: "var(--accent)", textDecoration: "none", wordBreak: "break-all", minWidth: 0 }}
            >
              {t.ap_open_original}
            </Link>
            {pageHost && <span style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>· {pageHost}</span>}
          </div>
        )}
      </div>
    );
  }

  return null;
}