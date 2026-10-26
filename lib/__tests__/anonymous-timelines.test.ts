import { describe, expect, it } from "vitest";
import {
  anonymousStreamAllowed,
  anonymousTimelineAllowed,
  normalizeAnonymousTimelineAccess,
} from "@/lib/anonymous-timelines";

describe("normalizeAnonymousTimelineAccess", () => {
  it("keeps the known levels and defaults to public", () => {
    expect(normalizeAnonymousTimelineAccess("public_local")).toBe("public_local");
    expect(normalizeAnonymousTimelineAccess("none")).toBe("none");
    expect(normalizeAnonymousTimelineAccess("public")).toBe("public");
    expect(normalizeAnonymousTimelineAccess("garbage")).toBe("public");
    expect(normalizeAnonymousTimelineAccess(null)).toBe("public");
  });
});

describe("anonymousTimelineAllowed", () => {
  it("applies the REST rule", () => {
    expect(anonymousTimelineAllowed("public", false)).toBe(true);
    expect(anonymousTimelineAllowed("public", true)).toBe(false);
    expect(anonymousTimelineAllowed("public_local", true)).toBe(true);
    expect(anonymousTimelineAllowed("none", false)).toBe(false);
    expect(anonymousTimelineAllowed("none", true)).toBe(false);
  });
});

describe("anonymousStreamAllowed", () => {
  it("gates the public stream views like the worker does at connect time", () => {
    expect(anonymousStreamAllowed("public", "public")).toBe(true);
    expect(anonymousStreamAllowed("public:remote", "public")).toBe(false);
    expect(anonymousStreamAllowed("public:local", "public")).toBe(false);
    expect(anonymousStreamAllowed("public:local", "public_local")).toBe(true);
    expect(anonymousStreamAllowed("public", "none")).toBe(false);
  });

  it("keeps hashtag streams session-only (REST parity)", () => {
    expect(anonymousStreamAllowed("hashtag:cats", "public")).toBe(false);
    expect(anonymousStreamAllowed("hashtag:local:cats", "public_local")).toBe(false);
  });

  it("never opens authenticated channels to an anonymous socket", () => {
    for (const channel of ["home:alice", "user:alice", "direct:alice", "notification:alice", "list:42"]) {
      expect(anonymousStreamAllowed(channel, "public_local")).toBe(false);
    }
  });
});
