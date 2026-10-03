// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { licenseVisual } from "@/lib/license-client";

describe("licenseVisual", () => {
  it("prefers the badge letters the admin set over the image and the derived badges", () => {
    expect(
      licenseVisual({
        badgeText: "CC BY",
        icon: "https://licensebuttons.net/l/by/4.0/88x31.png",
        url: "https://creativecommons.org/licenses/by/4.0/",
      })
    ).toEqual({ kind: "text", label: "CC BY" });
    expect(licenseVisual({ badgeText: "  MI-LIC  ", url: "https://otra.example/licenses/mi-licencia" }))
      .toEqual({ kind: "text", label: "MI-LIC" });
    // Empty text falls through to the image (seeded CC buttons keep working).
    expect(licenseVisual({ badgeText: "", icon: "https://x.example/i.png", url: "https://example.com/l" }))
      .toEqual({ kind: "image", src: "https://x.example/i.png" });
  });

  it("prefers the icon image of the catalogue entry", () => {
    expect(licenseVisual({ icon: "https://licensebuttons.net/l/by/4.0/88x31.png", url: "https://creativecommons.org/licenses/by/4.0/" }))
      .toEqual({ kind: "image", src: "https://licensebuttons.net/l/by/4.0/88x31.png" });
  });

  it("uses the badges of a known license URI", () => {
    expect(licenseVisual({ icon: "", url: "https://creativecommons.org/licenses/by-sa/4.0/" }))
      .toEqual({ kind: "icons", names: ["cc", "cc-by", "cc-sa"] });
    expect(licenseVisual({ icon: "", badges: "cc cc-zero", url: "https://example.com/x" }))
      .toEqual({ kind: "icons", names: ["cc", "cc-zero"] });
  });

  it("falls back to the letters of the id for a custom license from a peer", () => {
    expect(licenseVisual({ icon: "", url: "https://otra.example/licenses/mi-licencia" }))
      .toEqual({ kind: "text", label: "MI-LICENCIA" });
  });
});
