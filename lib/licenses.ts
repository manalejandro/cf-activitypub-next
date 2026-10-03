/**
 * FEP-6757 content licensing helpers.
 *
 * Licenses are identified by their canonical URI (Creative Commons, CC0, the
 * public domain mark, rightsstatements.org…). The catalogue lives in D1; these
 * helpers map a URI to its badge icons and its localised label keys, so a
 * status keeps rendering its license even when the catalogue entry is gone or
 * when the license came from a remote instance.
 */

/**
 * Fork Awesome badge names for a canonical license URI (space-separated, so a
 * CC license can show `cc cc-by cc-sa` like the official badges). Used when the
 * catalogue entry has no icon image and the URI is a known license.
 */
export function licenseIconsForUrl(url: string): string {
  const u = (url || "").toLowerCase();
  if (!u) return "";
  if (u.includes("creativecommons.org/publicdomain/zero")) return "cc cc-zero";
  if (u.includes("creativecommons.org/publicdomain/mark")) return "cc cc-pd";
  if (u.includes("creativecommons.org/licenses/")) {
    const code = u.split("/licenses/")[1]?.split("/")[0] ?? "";
    const icons = ["cc"];
    if (code.includes("by")) icons.push("cc-by");
    if (code.includes("nc")) icons.push("cc-nc");
    if (code.includes("sa")) icons.push("cc-sa");
    if (code.includes("nd")) icons.push("cc-nd");
    return icons.join(" ");
  }
  if (u.includes("rightsstatements.org/vocab/inc")) return "copyright";
  if (u.includes("rightsstatements.org")) return "balance-scale";
  return "";
}

/**
 * Last resort label for a license we know nothing about: the letters of its id
 * (the URI's last meaningful path segment), e.g. `…/licenses/mi-licencia` →
 * `MI-LICENCIA`. Capped so it stays a badge.
 */
export function licenseIdLetters(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? parsed.hostname;
    return decodeURIComponent(last).replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toUpperCase().slice(0, 12);
  } catch {
    return "";
  }
}

/** The origin instance of a license URI (scheme + host), for remote lookups. */
export function licenseOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** i18n key of a built-in license entry (`license_cc_by_sa_4_0_name`). */
export function licenseI18nKey(id: string, part: "name" | "desc"): string {
  return `license_${id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}_${part}`;
}

/** License ids are URL slugs (`/licenses/<id>`). */
export function normalizeLicenseId(input: string): string | null {
  const id = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return id.length >= 2 ? id : null;
}

/** FEP-6757: read the license of an ActivityPub object (`license`, plus the
 *  `schema:license` / `cc:license` aliases the FEP allows as alternatives). */
export function extractLicenseUrl(obj: Record<string, unknown>): string | null {
  for (const key of ["license", "schema:license", "cc:license"]) {
    const value = obj[key];
    const url = typeof value === "string" ? value : (value as { id?: string } | undefined)?.id;
    if (typeof url === "string" && /^https:\/\//i.test(url)) return url;
  }
  return null;
}

/** A license URI must be https and free of credentials/fragments. */
export function normalizeLicenseUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
