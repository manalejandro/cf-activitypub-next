import { PROFILE_IMAGE_MIME_TYPES } from "@/lib/constants";

/**
 * Decision for an `avatar` / `header` form field of PATCH
 * /api/v1/accounts/verify_credentials.
 *
 * Mastodon's contract: a file uploads the image, an **empty string removes
 * it**, and anything else is ignored. Type and size are validated here so the
 * client gets a translated `error_code` instead of silently storing junk.
 */
export type ProfileImageDecision =
  | { action: "none" }
  | { action: "clear" }
  | { action: "upload"; file: File }
  | { action: "error"; error: string; error_code: "media_error_type" | "media_error_too_large" };

export function profileImageDecision(
  value: FormDataEntryValue | null,
  maxBytes: number
): ProfileImageDecision {
  if (value === null) return { action: "none" };
  if (typeof value === "string") return value === "" ? { action: "clear" } : { action: "none" };
  if (value.size === 0) return { action: "none" };

  if (!PROFILE_IMAGE_MIME_TYPES.includes(value.type)) {
    return { action: "error", error: "Unsupported file type", error_code: "media_error_type" };
  }
  if (value.size > maxBytes) {
    const maxMb = Math.max(1, Math.round(maxBytes / (1024 * 1024)));
    return {
      action: "error",
      error: `File too large (max ${maxMb} MB)`,
      error_code: "media_error_too_large",
    };
  }
  return { action: "upload", file: value };
}
