import { describe, it, expect } from "vitest";
import {
  findEmojiQuery,
  replaceEmojiQuery,
  getEmojiSuggestions,
} from "@/lib/emoji-autocomplete";

describe("findEmojiQuery", () => {
  it("returns the query when typing : + 2 letters at the end", () => {
    expect(findEmojiQuery("hola :fi", 8)).toEqual({ start: 5, end: 8, query: "fi" });
  });

  it("returns null when only 1 letter follows the colon", () => {
    expect(findEmojiQuery("hola :f", 6)).toBeNull();
  });

  it("returns null when there is no colon", () => {
    expect(findEmojiQuery("hola fi", 6)).toBeNull();
  });

  it("returns null when a word character precedes the colon (no boundary)", () => {
    expect(findEmojiQuery("file:ts", 7)).toBeNull();
    expect(findEmojiQuery("http://x", 8)).toBeNull();
  });

  it("matches in the middle of the text", () => {
    const text = "Mira :fir más";
    expect(findEmojiQuery(text, 9)).toEqual({ start: 5, end: 9, query: "fir" });
  });

  it("supports underscores in the query", () => {
    expect(findEmojiQuery(":thumbs_up", 10)).toEqual({ start: 0, end: 10, query: "thumbs_up" });
  });
});

describe("replaceEmojiQuery", () => {
  it("replaces the range with the inserted emoji", () => {
    expect(replaceEmojiQuery("hola :fi", { start: 5, end: 8 }, "🔥")).toBe("hola 🔥");
  });
});

describe("getEmojiSuggestions", () => {
  const custom = [
    { shortcode: "blobcat", url: "a.png", static_url: "a.png" },
    { shortcode: "blobaww", url: "b.png", static_url: "b.png" },
    { shortcode: "hidden", url: "c.png", static_url: "c.png", visible_in_picker: false },
  ];

  it("matches unicode emojis by name prefix", () => {
    const results = getEmojiSuggestions("fire", []);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].char).toBe("🔥");
    expect(results[0].type).toBe("unicode");
  });

  it("matches unicode emojis by name containing the query", () => {
    const results = getEmojiSuggestions("grinn", []);
    expect(results.some((r) => r.name === "grinning face")).toBe(true);
  });

  it("matches custom emojis by shortcode", () => {
    const results = getEmojiSuggestions("blob", custom);
    const blobcat = results.find((r) => r.type === "custom" && r.shortcode === "blobcat");
    expect(blobcat).toBeDefined();
    expect(blobcat?.insert).toBe(":blobcat:");
  });

  it("includes custom emojis hidden from the picker in autocomplete", () => {
    const results = getEmojiSuggestions("hidden", custom);
    expect(results.some((r) => r.shortcode === "hidden")).toBe(true);
  });

  it("ranks prefix matches above contains matches", () => {
    const results = getEmojiSuggestions("fire", []);
    const prefix = results.filter((r) => r.name.startsWith("fire"));
    const contains = results.filter((r) => !r.name.startsWith("fire"));
    expect(prefix.length).toBeGreaterThan(0);
    for (const c of contains) {
      const pIdx = results.indexOf(prefix[0]);
      const cIdx = results.indexOf(c);
      expect(pIdx).toBeLessThan(cIdx);
    }
  });

  it("honours the limit", () => {
    const results = getEmojiSuggestions("a", []);
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it("returns empty when nothing matches", () => {
    expect(getEmojiSuggestions("zzzz", [])).toEqual([]);
  });
});