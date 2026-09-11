// @vitest-environment node
import { describe, it, expect } from "vitest";
import { collectionHref, isExternalCollection } from "@/lib/collection-link";

describe("collectionHref", () => {
  it("routes local collections to the local page", () => {
    expect(collectionHref({ id: "abc", local: true })).toBe("/collections/abc");
    expect(collectionHref({ id: "a b", local: true })).toBe("/collections/a%20b");
  });

  it("points remote collections at their web URL", () => {
    const remote = { id: "https://remote.example/featured_collections/1", local: false, url: "https://remote.example/c/1" };
    expect(collectionHref(remote)).toBe("https://remote.example/c/1");
    expect(collectionHref({ ...remote, url: null })).toBe(remote.id);
    expect(isExternalCollection(remote)).toBe(true);
    expect(isExternalCollection({ local: true })).toBe(false);
  });
});
