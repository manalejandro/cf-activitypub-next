"use client";

/**
 * Client-side helpers for the FEP-6757 license catalogue: one cached fetch of
 * `/api/v1/licenses`, the visual resolution of a license (icon image → known
 * badges → the letters of its id) and a cached lookup for licenses that arrive
 * from other instances.
 */

import type { Translations } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { licenseI18nKey, licenseIconsForUrl, licenseIdLetters } from "@/lib/licenses";

export interface ClientLicense {
  id: string;
  name: string;
  url: string;
  /** Icon image URL set by the admin (empty when the instance has none). */
  icon: string;
  /** Fork Awesome badge keys set by the admin (empty = image, known badge or derived letters). */
  badgeKeys?: string;
  /** Fork Awesome badges derived from the URI (empty for unknown licenses). */
  badges?: string;
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

/** How a license should be drawn. */
export type LicenseVisual =
  | { kind: "image"; src: string }
  | { kind: "icons"; names: string[] }
  | { kind: "text"; label: string };

/**
 * Resolution order: the Fork Awesome badge keys the admin set, the icon image,
 * the badges of a known license URI, and finally the letters of its id — a
 * custom license from another instance shows `MI-LICENCIA` until we learn more.
 */
export function licenseVisual(license: {
  badgeKeys?: string | null;
  icon?: string | null;
  badges?: string | null;
  url: string;
}): LicenseVisual {
  const keys = (license.badgeKeys ?? "").trim();
  if (keys) return { kind: "icons", names: keys.split(/\s+/) };
  if (license.icon) return { kind: "image", src: license.icon };
  const badges = license.badges || licenseIconsForUrl(license.url);
  if (badges) return { kind: "icons", names: badges.split(" ") };
  return { kind: "text", label: licenseIdLetters(license.url) || "?" };
}

/** Localised name: built-in entries have translations, custom ones use the stored name. */
export function licenseName(t: Translations, license: Pick<ClientLicense, "id" | "name">): string {
  const key = licenseI18nKey(license.id, "name");
  const translated = (t as unknown as Record<string, string | undefined>)[key];
  return translated ?? license.name;
}

const lookups = new Map<string, Promise<ClientLicense | null>>();

/**
 * Ask the server about a license we do not have in the catalogue: it queries
 * the origin instance (its `/api/v1/licenses`) and caches the answer, so a
 * custom license from a peer shows its real name and icon instead of nothing.
 */
export function lookupLicense(url: string): Promise<ClientLicense | null> {
  const hit = lookups.get(url);
  if (hit) return hit;
  const request = fetch(`/api/v1/licenses/lookup?url=${encodeURIComponent(url)}`)
    .then((res) => (res.ok ? (res.json() as Promise<ClientLicense | null>) : null))
    .catch(() => null);
  lookups.set(url, request);
  return request;
}

/**
 * Everything the UI needs about the license of a status: the local catalogue
 * entry, the origin instance's answer, or a placeholder carrying just the URI
 * (so the badge falls back to the letters of its id).
 */
export function useLicenseInfo(url: string | null | undefined): ClientLicense | null {
  const [license, setLicense] = useState<ClientLicense | null>(null);
  // Render-phase reset when the status changes (React's recommended pattern for
  // "state that resets when a prop changes") — no setState from an effect.
  const [prevUrl, setPrevUrl] = useState(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setLicense(null);
  }
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void (async () => {
      const local = findLicense(await fetchLicenses(), url);
      if (local) {
        if (alive) setLicense(local);
        return;
      }
      const remote = await lookupLicense(url);
      if (alive) setLicense(remote ?? { id: licenseIdLetters(url) || url, name: url, url, icon: "" });
    })();
    return () => { alive = false; };
  }, [url]);
  return license;
}
