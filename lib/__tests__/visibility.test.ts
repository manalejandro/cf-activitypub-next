import { describe, it, expect } from "vitest";
import { normalizeVisibility, toApiVisibility } from "@/lib/mastodon/visibility";

describe("normalizeVisibility", () => {
  it("accepts the internal values unchanged", () => {
    expect(normalizeVisibility("public")).toBe("public");
    expect(normalizeVisibility("unlisted")).toBe("unlisted");
    expect(normalizeVisibility("followers")).toBe("followers");
    expect(normalizeVisibility("direct")).toBe("direct");
  });

  it("maps the Mastodon API value private to the internal followers", () => {
    expect(normalizeVisibility("private")).toBe("followers");
  });

  it("rejects invalid values", () => {
    expect(normalizeVisibility("everyone")).toBeNull();
    expect(normalizeVisibility("")).toBeNull();
    expect(normalizeVisibility(42)).toBeNull();
    expect(normalizeVisibility(undefined)).toBeNull();
    expect(normalizeVisibility(null)).toBeNull();
  });
});

describe("toApiVisibility", () => {
  it("maps the internal followers to the Mastodon API value private", () => {
    expect(toApiVisibility("followers")).toBe("private");
  });

  it("passes through the other values", () => {
    expect(toApiVisibility("public")).toBe("public");
    expect(toApiVisibility("unlisted")).toBe("unlisted");
    expect(toApiVisibility("direct")).toBe("direct");
  });
});