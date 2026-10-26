import { describe, expect, it } from "vitest";
import { parseKeywordsAttributes } from "@/lib/mastodon/filters";
import { MAX_FILTER_KEYWORDS, MAX_FILTER_KEYWORD_CHARS } from "@/lib/constants";

describe("parseKeywordsAttributes", () => {
  it("caps the JSON array branch at MAX_FILTER_KEYWORDS", () => {
    const many = Array.from({ length: MAX_FILTER_KEYWORDS + 25 }, (_, i) => ({
      keyword: `kw${i}`,
      whole_word: false,
    }));
    expect(parseKeywordsAttributes({ keywords_attributes: many })).toHaveLength(MAX_FILTER_KEYWORDS);
  });

  it("caps each keyword's length", () => {
    const out = parseKeywordsAttributes({
      keywords_attributes: [{ keyword: "x".repeat(MAX_FILTER_KEYWORD_CHARS + 100) }],
    });
    expect(out[0].keyword).toHaveLength(MAX_FILTER_KEYWORD_CHARS);
  });

  it("keeps the form-encoded branch capped at the same maximum", () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < MAX_FILTER_KEYWORDS + 25; i++) {
      raw[`keywords_attributes[${i}][keyword]`] = `kw${i}`;
    }
    expect(parseKeywordsAttributes(raw)).toHaveLength(MAX_FILTER_KEYWORDS);
  });

  it("drops empty keywords and reads whole_word", () => {
    const out = parseKeywordsAttributes({
      keywords_attributes: [
        { keyword: "  " },
        { keyword: "spam", whole_word: "true" },
        { keyword: "ads", whole_word: true },
      ],
    });
    expect(out).toEqual([
      { keyword: "spam", whole_word: true },
      { keyword: "ads", whole_word: true },
    ]);
  });
});
