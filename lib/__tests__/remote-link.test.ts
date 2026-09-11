// @vitest-environment node
import { describe, it, expect } from "vitest";
import { externalProfileUrl } from "@/lib/remote-link";

describe("externalProfileUrl", () => {
  it("builds the home-instance profile URL for a remote handle", () => {
    expect(externalProfileUrl("manalejandro@cf-ap.com", "", "mastodon.la")).toBe(
      "https://cf-ap.com/@manalejandro"
    );
  });

  it("preserves the rest of the path (status permalinks)", () => {
    expect(externalProfileUrl("alice@remote.example", "/123456", "local.example")).toBe(
      "https://remote.example/@alice/123456"
    );
  });

  it("keeps same-instance handles local", () => {
    expect(externalProfileUrl("alice@cf-ap.com", "", "cf-ap.com")).toBeNull();
    expect(externalProfileUrl("alice@CF-AP.com", "", "cf-ap.com")).toBeNull();
  });

  it("ignores plain local usernames and malformed handles", () => {
    expect(externalProfileUrl("alice", "", "cf-ap.com")).toBeNull();
    expect(externalProfileUrl("@remote.example", "", "cf-ap.com")).toBeNull();
    expect(externalProfileUrl("alice@", "", "cf-ap.com")).toBeNull();
  });
});
