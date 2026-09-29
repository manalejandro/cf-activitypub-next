"use client";

import { translateKey, type Translations } from "@/lib/i18n";
import type { MediaAttachment } from "@/components/StatusCard";

/**
 * Shared client-side media upload for every composer.
 *
 * One code path for the home composer, the reply composer and the edit-status
 * modal: the same endpoint, the same cap behaviour and — the part that was
 * missing — a localized message when a file is rejected (unsupported type,
 * over the instance limit) instead of a silent failure.
 */

export interface MediaUploadOptions {
  /** Bearer token; omit to rely on the session cookie. */
  token?: string | null;
  locale: string;
  /** Blur the attachment by default (CW/sensitive enabled). */
  sensitive?: boolean;
  /** Slots left in the composer (`limits.maxMediaAttachments - attached`). */
  remaining: number;
  /** Attachment cap shown in the "too many files" message. */
  maxAttachments: number;
  /** Instance upload limit in bytes (`limits.maxImageSize`). */
  maxBytes: number;
  t: Translations;
}

export interface MediaUploadResult {
  attachments: MediaAttachment[];
  /** Localized, user-facing message for the first rejected/failed file. */
  error: string | null;
}

/** `2 MB` / `512 KB` for UI hints. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Server error → localized message (`error_code` first, English text as fallback). */
export function mediaUploadError(
  payload: { error?: string; error_code?: string } | null,
  t: Translations,
  maxBytes: number
): string {
  const code = payload?.error_code;
  if (code === "media_error_too_large") {
    return t.media_error_too_large.replace("{value}", formatBytes(maxBytes));
  }
  return translateKey(t, code, payload?.error ?? t.compose_upload_error) ?? t.compose_upload_error;
}

export async function uploadMediaFiles(
  files: File[],
  options: MediaUploadOptions
): Promise<MediaUploadResult> {
  const { token, locale, sensitive, remaining, maxAttachments, maxBytes, t } = options;
  const accepted = files.slice(0, Math.max(0, remaining));
  const limitMessage = t.composer_upload_limit.replace("{value}", String(maxAttachments));
  if (accepted.length === 0) {
    return { attachments: [], error: files.length > 0 ? limitMessage : null };
  }

  const attachments: MediaAttachment[] = [];
  let error: string | null = null;
  if (files.length > accepted.length) {
    error = limitMessage;
  }

  for (const file of accepted) {
    const form = new FormData();
    form.append("file", file);
    form.append("locale", locale);
    if (sensitive) form.append("sensitive", "true");
    try {
      const res = await fetch("/api/v1/media", {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      if (res.ok) {
        attachments.push((await res.json()) as MediaAttachment);
        continue;
      }
      const payload = (await res.json().catch(() => null)) as { error?: string; error_code?: string } | null;
      if (!error) error = mediaUploadError(payload, t, maxBytes);
    } catch {
      if (!error) error = t.compose_upload_error;
    }
  }

  return { attachments, error };
}
