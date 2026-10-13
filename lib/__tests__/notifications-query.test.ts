import { describe, expect, it } from "vitest";
import { notificationsQuery } from "@/lib/notifications-query";

describe("notificationsQuery", () => {
  it("leaves the all tab unfiltered", () => {
    expect(notificationsQuery("all", 20)).toBe("/api/v1/notifications?limit=20");
    expect(notificationsQuery("all", 20, "42")).toBe("/api/v1/notifications?limit=20&max_id=42");
  });

  it("carries the mentions tab's types, DMs included like Mastodon", () => {
    expect(notificationsQuery("mentions", 20)).toBe(
      "/api/v1/notifications?limit=20&types%5B%5D=mention&types%5B%5D=direct&types%5B%5D=encrypted"
    );
  });

  it("keeps the cursor on the filtered stream", () => {
    expect(notificationsQuery("mentions", 40, "99")).toBe(
      "/api/v1/notifications?limit=40&types%5B%5D=mention&types%5B%5D=direct&types%5B%5D=encrypted&max_id=99"
    );
  });

  it("builds the stream's single-notification fetch", () => {
    expect(notificationsQuery("all", 1)).toBe("/api/v1/notifications?limit=1");
    expect(notificationsQuery("mentions", 1)).toBe(
      "/api/v1/notifications?limit=1&types%5B%5D=mention&types%5B%5D=direct&types%5B%5D=encrypted"
    );
  });
});
