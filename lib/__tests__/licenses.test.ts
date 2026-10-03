// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  extractLicenseUrl,
  licenseI18nKey,
  licenseIconsForUrl,
  normalizeLicenseId,
  normalizeLicenseUrl,
} from "@/lib/licenses";

describe("licenseIconsForUrl", () => {
  it("maps the canonical CC URIs to their badge icons", () => {
    expect(licenseIconsForUrl("https://creativecommons.org/licenses/by/4.0/")).toBe("cc cc-by");
    expect(licenseIconsForUrl("https://creativecommons.org/licenses/by-sa/4.0/")).toBe("cc cc-by cc-sa");
    expect(licenseIconsForUrl("https://creativecommons.org/licenses/by-nc-sa/4.0/")).toBe("cc cc-by cc-nc cc-sa");
    expect(licenseIconsForUrl("https://creativecommons.org/licenses/by-nc-nd/4.0/")).toBe("cc cc-by cc-nc cc-nd");
    expect(licenseIconsForUrl("https://creativecommons.org/publicdomain/zero/1.0/")).toBe("cc cc-zero");
    expect(licenseIconsForUrl("https://creativecommons.org/publicdomain/mark/1.0/")).toBe("cc cc-pd");
    expect(licenseIconsForUrl("https://rightsstatements.org/vocab/InC/1.0/")).toBe("copyright");
  });

  it("falls back to a generic icon for unknown licenses", () => {
    expect(licenseIconsForUrl("https://example.com/my-license")).toBe("certificate");
    expect(licenseIconsForUrl("")).toBe("certificate");
  });
});

describe("licenseI18nKey", () => {
  it("derives the localisation key of a built-in entry", () => {
    expect(licenseI18nKey("cc-by-sa-4-0", "desc")).toBe("license_cc_by_sa_4_0_desc");
    expect(licenseI18nKey("inc-1-0", "name")).toBe("license_inc_1_0_name");
  });
});

describe("normalizeLicenseId / normalizeLicenseUrl", () => {
  it("builds a slug id from a name", () => {
    expect(normalizeLicenseId("CC BY-SA 4.0")).toBe("cc-by-sa-4-0");
    expect(normalizeLicenseId("  Mi Licencia  ")).toBe("mi-licencia");
    expect(normalizeLicenseId("a")).toBeNull();
  });

  it("accepts only public https license URLs", () => {
    expect(normalizeLicenseUrl(" https://example.com/l#frag ")).toBe("https://example.com/l");
    expect(normalizeLicenseUrl("http://example.com/l")).toBeNull();
    expect(normalizeLicenseUrl("https://user:pass@example.com/l")).toBeNull();
    expect(normalizeLicenseUrl("no url")).toBeNull();
  });
});

describe("extractLicenseUrl", () => {
  it("reads license plus the schema:license / cc:license aliases", () => {
    expect(extractLicenseUrl({ license: "https://creativecommons.org/licenses/by/4.0/" }))
      .toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(extractLicenseUrl({ "schema:license": "https://example.com/l" })).toBe("https://example.com/l");
    expect(extractLicenseUrl({ "cc:license": { id: "https://example.com/cc" } })).toBe("https://example.com/cc");
  });

  it("ignores insecure or missing values", () => {
    expect(extractLicenseUrl({ license: "http://example.com/l" })).toBeNull();
    expect(extractLicenseUrl({ license: "" })).toBeNull();
    expect(extractLicenseUrl({})).toBeNull();
  });
});
