"use client";

/**
 * Client-side helpers for the FEP-6757 license catalogue: one cached fetch of
 * `/api/v1/licenses`, the badge icons of a license and its localised name.
 */

import type { Translations } from "@/lib/i18n";
import { licenseI18nKey, licenseIconsForUrl } from "@/lib/licenses";

export interface ClientLicense {
  id: string;
  name: string;
  url: string;
  icon: string;
}

let cached: ClientLicense[] | null = null;
let pending: Promise<ClientLicense[]> | null = null;

/** The instance catalogue, fetched once per page load. */
export async function fetchLicenses(): Promise<ClientLicense[]> {
  if (cached) return cached;
  if (!pending) {
    pending = fetch("/api/v1/licenses")
      .then((res) => (res.ok ? (res.json() as Promise<ClientLicense[]>) : []))
      .catch(() => [])
      .then((list) => {
        cached = Array.isArray(list) ? list : [];
        pending = null;
        return cached;
      });
  }
  return pending;
}

/** The catalogue entry for a status' `license_url`, when it is ours. */
export function findLicense(list: ClientLicense[], url: string | null | undefined): ClientLicense | null {
  if (!url) return null;
  return list.find((l) => l.url === url) ?? null;
}

/** Fork Awesome badges for a license (catalogue override, else from the URL). */
export function licenseBadges(license: Pick<ClientLicense, "icon" | "url">): string {
  return license.icon || licenseIconsForUrl(license.url);
}

/** Localised name: built-in entries have translations, custom ones use the stored name. */
export function licenseName(t: Translations, license: Pick<ClientLicense, "id" | "name">): string {
  const key = licenseI18nKey(license.id, "name");
  const translated = (t as unknown as Record<string, string | undefined>)[key];
  return translated ?? license.name;
}
