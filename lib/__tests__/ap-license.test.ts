// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildActor, buildNote } from "@/lib/activitypub/utils";
import { FEP_6757_CONTEXT } from "@/lib/activitypub/vocab";

const LICENSE = "https://creativecommons.org/licenses/by-sa/4.0/";

describe("FEP-6757 license metadata", () => {
  it("puts the license on the note and extends the context", () => {
    const note = buildNote("https://cf-ap.com", "abc-123", {
      actorUsername: "manalejandro",
      content: "<p>hola</p>",
      published: "2026-10-03T00:00:00Z",
      visibility: "public",
      licenseUrl: LICENSE,
    });

    expect((note as Record<string, unknown>).license).toBe(LICENSE);
    expect(note["@context"]).toContain(FEP_6757_CONTEXT);
  });

  it("omits both when the status has no license", () => {
    const note = buildNote("https://cf-ap.com", "abc-123", {
      actorUsername: "manalejandro",
      content: "<p>hola</p>",
      published: "2026-10-03T00:00:00Z",
      visibility: "public",
    });

    expect((note as Record<string, unknown>).license).toBeUndefined();
    expect(note["@context"]).not.toContain(FEP_6757_CONTEXT);
  });

  it("puts preferredLicense on the actor, never as a fallback license", () => {
    const actor = buildActor("https://cf-ap.com", "manalejandro", {
      publicKeyPem: "pem",
      preferredLicenseUrl: LICENSE,
    } as never);

    expect((actor as Record<string, unknown>).preferredLicense).toBe(LICENSE);
    expect((actor as Record<string, unknown>).license).toBeUndefined();
    expect(actor["@context"]).toContain(FEP_6757_CONTEXT);

    const bare = buildActor("https://cf-ap.com", "manalejandro", { publicKeyPem: "pem" } as never);
    expect((bare as Record<string, unknown>).preferredLicense).toBeUndefined();
  });
});
