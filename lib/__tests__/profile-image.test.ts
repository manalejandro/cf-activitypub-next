// @vitest-environment node
import { describe, it, expect } from "vitest";
import { profileImageDecision } from "@/lib/media/profile-image";

const MAX = 2 * 1024 * 1024;

function file(name: string, type: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("profileImageDecision", () => {
  it("ignores a missing field and a non-empty string value", () => {
    expect(profileImageDecision(null, MAX)).toEqual({ action: "none" });
    expect(profileImageDecision("https://example.com/a.png", MAX)).toEqual({ action: "none" });
  });

  it("removes the image when the field is an empty string (Mastodon's contract)", () => {
    expect(profileImageDecision("", MAX)).toEqual({ action: "clear" });
  });

  it("accepts the supported image formats", () => {
    const decision = profileImageDecision(file("a.webp", "image/webp", 1024), MAX);
    expect(decision.action).toBe("upload");
    expect(decision.action === "upload" && decision.file.name).toBe("a.webp");
  });

  it("rejects unsupported types and oversized files with translated codes", () => {
    const bad = profileImageDecision(file("a.txt", "text/plain", 10), MAX);
    expect(bad).toEqual({ action: "error", error: "Unsupported file type", error_code: "media_error_type" });

    const big = profileImageDecision(file("a.png", "image/png", MAX + 1), MAX);
    expect(big).toMatchObject({ action: "error", error_code: "media_error_too_large" });
    expect(big.action === "error" && big.error).toContain("2 MB");
  });

  it("ignores an empty file input", () => {
    expect(profileImageDecision(file("a.png", "image/png", 0), MAX)).toEqual({ action: "none" });
  });
});
