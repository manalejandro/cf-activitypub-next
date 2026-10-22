// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  DB_SLOW_MS,
  DELIVERY_DEGRADED_FAILURES,
  DELIVERY_DOWN_FAILURES,
  FEDERATION_STALE_HOURS,
  MAINTENANCE_OK_MINUTES,
  MAINTENANCE_STALE_MINUTES,
  MEDIA_BACKLOG_FACTOR,
  databaseState,
  deliveryState,
  federationState,
  maintenanceState,
  mediaState,
  summarizeOverall,
} from "@/lib/instance-stats";

describe("component state thresholds", () => {
  it("judges the database by the probe round-trip", () => {
    expect(databaseState(null)).toBe("down");
    expect(databaseState(DB_SLOW_MS)).toBe("operational");
    expect(databaseState(DB_SLOW_MS + 1)).toBe("degraded");
  });

  it("only calls federation degraded when there is a graph to lose", () => {
    // A brand-new instance with no remote accounts is not degraded, however
    // quiet it is; one with a graph and nothing inbound for the window is.
    expect(federationState(null, 0)).toBe("operational");
    expect(federationState(null, 42)).toBe("degraded");
    expect(federationState(FEDERATION_STALE_HOURS * 60, 42)).toBe("operational");
    expect(federationState(FEDERATION_STALE_HOURS * 60 + 1, 42)).toBe("degraded");
  });

  it("scales delivery failures from degraded to down", () => {
    expect(deliveryState(0)).toBe("operational");
    expect(deliveryState(DELIVERY_DEGRADED_FAILURES - 1)).toBe("operational");
    expect(deliveryState(DELIVERY_DEGRADED_FAILURES)).toBe("degraded");
    expect(deliveryState(DELIVERY_DOWN_FAILURES)).toBe("down");
  });

  it("reports the media cache as disabled, degraded or operational", () => {
    const base = { enabled: true, bytes: 0, pending: 0, maxBytes: 1000, fetchBatch: 10 };
    expect(mediaState({ ...base, enabled: false })).toBe("disabled");
    expect(mediaState(base)).toBe("operational");
    // Over budget.
    expect(mediaState({ ...base, bytes: 1001 })).toBe("degraded");
    // Backlog above a reasonable number of cron batches.
    expect(mediaState({ ...base, pending: 10 * MEDIA_BACKLOG_FACTOR })).toBe("operational");
    expect(mediaState({ ...base, pending: 10 * MEDIA_BACKLOG_FACTOR + 1 })).toBe("degraded");
  });

  it("maps the cron's last completed run to a state", () => {
    expect(maintenanceState(null)).toBe("unknown");
    expect(maintenanceState(MAINTENANCE_OK_MINUTES)).toBe("operational");
    expect(maintenanceState(MAINTENANCE_OK_MINUTES + 1)).toBe("degraded");
    expect(maintenanceState(MAINTENANCE_STALE_MINUTES)).toBe("degraded");
    expect(maintenanceState(MAINTENANCE_STALE_MINUTES + 1)).toBe("down");
  });
});

describe("overall verdict", () => {
  const component = (state: "operational" | "degraded" | "down" | "unknown" | "disabled") => ({
    key: "x",
    state,
    metrics: {},
  });

  it("reports the worst component state", () => {
    expect(summarizeOverall([component("operational"), component("operational")])).toBe("operational");
    expect(summarizeOverall([component("operational"), component("degraded")])).toBe("degraded");
    expect(summarizeOverall([component("degraded"), component("down")])).toBe("down");
  });

  it("does not let an unknown or disabled component drag the verdict", () => {
    expect(summarizeOverall([component("operational"), component("unknown")])).toBe("operational");
    expect(summarizeOverall([component("disabled"), component("unknown")])).toBe("operational");
  });
});
