import { describe, it, expect } from "vitest";
import { canonicalEmail, canonicalEmailHash } from "@/lib/canonical-email";

describe("canonicalEmail", () => {
  it("collapses plus-addressing on any domain", () => {
    expect(canonicalEmail("a544049483+b1r2@gmail.com")).toBe("a544049483@gmail.com");
    expect(canonicalEmail("a544049483+ap01@gmail.com")).toBe("a544049483@gmail.com");
    expect(canonicalEmail("user+tag@example.org")).toBe("user@example.org");
    expect(canonicalEmail("user+tag+more@example.org")).toBe("user@example.org");
  });

  it("collapses dotted local parts on any domain", () => {
    expect(canonicalEmail("a.544.049.483@gmail.com")).toBe("a544049483@gmail.com");
    expect(canonicalEmail("john.smith@example.com")).toBe("johnsmith@example.com");
    expect(canonicalEmail("a.544+tag@example.com")).toBe("a544@example.com");
  });

  it("treats googlemail and gmail as the same mailbox", () => {
    expect(canonicalEmail("User+social@googlemail.com")).toBe(canonicalEmail("user@gmail.com"));
  });

  it("lowercases, trims and leaves malformed input alone", () => {
    expect(canonicalEmail("  USER@EXAMPLE.COM  ")).toBe("user@example.com");
    expect(canonicalEmail("not-an-email")).toBe("not-an-email");
    expect(canonicalEmail("")).toBe("");
  });

  it("produces a stable sha256 hash of the canonical form", async () => {
    const a = await canonicalEmailHash("a544049483+b1r2@gmail.com");
    const b = await canonicalEmailHash("A.544.049.483+b1r1@googlemail.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await canonicalEmailHash("other@gmail.com"));
  });
});
