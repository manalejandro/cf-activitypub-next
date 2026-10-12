import { describe, it, expect } from "vitest";
import { parseAccountQuery } from "@/lib/account-search";

describe("parseAccountQuery", () => {
  it("keeps a plain username as text", () => {
    expect(parseAccountQuery("manalejandro")).toEqual({ text: "manalejandro" });
    expect(parseAccountQuery("  manalejandro  ")).toEqual({ text: "manalejandro" });
  });

  it("strips one leading @ from a handle (Mastodon's AccountSearchService)", () => {
    expect(parseAccountQuery("@alice@remote.example")).toEqual({
      text: "@alice@remote.example",
      username: "alice",
      domain: "remote.example",
    });
    expect(parseAccountQuery("alice@remote.example")).toEqual({
      text: "alice@remote.example",
      username: "alice",
      domain: "remote.example",
    });
  });

  it("reads a pasted profile URL (Mastodon's ResolveURLService)", () => {
    expect(parseAccountQuery("https://cf-ap.com/users/manalejandro")).toEqual({
      text: "https://cf-ap.com/users/manalejandro",
      username: "manalejandro",
      domain: "cf-ap.com",
      isUrl: true,
    });
    expect(parseAccountQuery("https://remote.example/@alice/")).toEqual({
      text: "https://remote.example/@alice/",
      username: "alice",
      domain: "remote.example",
      isUrl: true,
    });
    expect(parseAccountQuery("https://remote.example/users/a%20b")).toEqual({
      text: "https://remote.example/users/a%20b",
      username: "a b",
      domain: "remote.example",
      isUrl: true,
    });
  });

  it("does not treat other URLs as accounts", () => {
    expect(parseAccountQuery("https://example.com/some/post/123")).toEqual({
      text: "https://example.com/some/post/123",
    });
  });

  it("returns an empty text for a blank query", () => {
    expect(parseAccountQuery("   ")).toEqual({ text: "" });
  });
});
