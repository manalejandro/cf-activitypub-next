import { describe, it, expect } from "vitest";
import { resolveLimits, defaultMediaCacheUserAgents } from "@/lib/constants";

describe("media cache limits", () => {
  it("builds the bot user agent from INSTANCE_VERSION and INSTANCE_URL", () => {
    const limits = resolveLimits({ INSTANCE_VERSION: "9.9.9", INSTANCE_URL: "https://example.social" });
    expect(limits.mediaCacheUserAgents[0]).toBe(
      "cf-activitypub/9.9.9 (+https://example.social; federated media cache)"
    );
    // Browser fallbacks follow the instance bot UA.
    expect(limits.mediaCacheUserAgents.length).toBeGreaterThan(1);
  });

  it("lets MEDIA_CACHE_USER_AGENTS override the whole list", () => {
    const limits = resolveLimits({ MEDIA_CACHE_USER_AGENTS: "only-agent", INSTANCE_VERSION: "1.0" });
    expect(limits.mediaCacheUserAgents).toEqual(["only-agent"]);
  });

  it("falls back safely when the env carries no instance metadata", () => {
    expect(defaultMediaCacheUserAgents({})[0]).toBe(
      "cf-activitypub/0.1.0 (+https://localhost; federated media cache)"
    );
  });

  it("parses the enable flag and retention numbers", () => {
    expect(resolveLimits({}).mediaCacheEnabled).toBe(true);
    expect(resolveLimits({ MEDIA_CACHE_ENABLED: "false" }).mediaCacheEnabled).toBe(false);
    expect(resolveLimits({ MEDIA_CACHE_ENABLED: "off" }).mediaCacheEnabled).toBe(false);
    expect(resolveLimits({ MEDIA_CACHE_DAYS: "14" }).mediaCacheDays).toBe(14);
    expect(resolveLimits({ MEDIA_CACHE_MAX_BYTES: "123" }).mediaCacheMaxBytes).toBe(123);
  });
});
