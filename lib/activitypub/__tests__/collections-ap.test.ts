// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildFeaturedCollection } from "@/lib/activitypub/collections";
import type { CollectionRow } from "@/lib/db";
import type { LocalCollectionItem } from "@/lib/types";

const col: CollectionRow = {
  id: "abc",
  account_id: "https://local.example/users/alice",
  name: "Cool people",
  description: "desc",
  url: null,
  language: null,
  tag_name: "people",
  sensitive: 0,
  discoverable: 1,
  local: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  item_count: 2,
};

const items: LocalCollectionItem[] = [
  { id: "i1", collectionId: "abc", accountId: "https://local.example/users/bob", state: "accepted", createdAt: "2026-01-01T01:00:00Z" },
  { id: "i2", collectionId: "abc", accountId: "https://remote.example/users/carol", state: "accepted", createdAt: "2026-01-01T02:00:00Z" },
];

describe("buildFeaturedCollection (FEP-7aa9)", () => {
  it("builds the FeaturedCollection + FeaturedItem shape", () => {
    const ap = buildFeaturedCollection("https://local.example", "alice", col, items) as Record<string, unknown>;

    expect(ap.type).toBe("FeaturedCollection");
    expect(ap.id).toBe("https://local.example/users/alice/collections/abc");
    expect(ap.attributedTo).toBe("https://local.example/users/alice");
    expect(ap.url).toBe("https://local.example/collections/abc");
    expect(ap.totalItems).toBe(2);
    expect(ap.discoverable).toBe(true);
    expect((ap.topic as Record<string, unknown>).name).toBe("#people");

    const ordered = ap.orderedItems as Record<string, unknown>[];
    expect(ordered[0]).toMatchObject({
      type: "FeaturedItem",
      featuredObject: "https://local.example/users/bob",
      featureAuthorization: "https://local.example/users/alice/feature_authorizations/i1",
    });
    // Remote accounts can't be authorized by us: no featureAuthorization.
    expect(ordered[1].featuredObject).toBe("https://remote.example/users/carol");
    expect(ordered[1].featureAuthorization).toBeUndefined();
  });

  it("uses summaryMap when the collection has a language", () => {
    const ap = buildFeaturedCollection(
      "https://local.example",
      "alice",
      { ...col, language: "es" },
      []
    ) as Record<string, unknown>;
    expect(ap.summaryMap).toEqual({ es: "desc" });
    expect(ap.summary).toBeUndefined();
  });
});
