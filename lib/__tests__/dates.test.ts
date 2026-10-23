// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dbTimestamp, isoTimestamp, parseDbDate, toIsoOrNull } from "@/lib/dates";

describe("toIsoOrNull", () => {
  it("converts the database shape (datetime('now')) to ISO with Z", () => {
    expect(toIsoOrNull("2026-10-23 19:33:23")).toBe("2026-10-23T19:33:23.000Z");
  });

  it("keeps an ISO value and adds the zone to a Z-less ISO", () => {
    expect(toIsoOrNull("2026-10-23T19:33:23.123Z")).toBe("2026-10-23T19:33:23.123Z");
    // JS would read this shape as *local* time: it is UTC, as stored.
    expect(toIsoOrNull("2026-10-23T19:33:23")).toBe("2026-10-23T19:33:23.000Z");
    expect(toIsoOrNull("2026-10-23T19:33:23.123")).toBe("2026-10-23T19:33:23.123Z");
  });

  it("returns null for missing or unparseable values", () => {
    expect(toIsoOrNull(null)).toBeNull();
    expect(toIsoOrNull(undefined)).toBeNull();
    expect(toIsoOrNull("")).toBeNull();
    expect(toIsoOrNull("not a date")).toBeNull();
    expect(toIsoOrNull(123)).toBeNull();
  });
});

describe("isoTimestamp", () => {
  it("never returns null: a missing value falls back to now", () => {
    const before = Date.now();
    const value = isoTimestamp(null);
    expect(Date.parse(value)).toBeGreaterThanOrEqual(before - 1000);
    expect(value.endsWith("Z")).toBe(true);
  });

  it("normalises the stored shape", () => {
    expect(isoTimestamp("2026-08-07 12:51:03")).toBe("2026-08-07T12:51:03.000Z");
  });
});

describe("dbTimestamp", () => {
  it("writes the shape datetime('now') writes", () => {
    expect(dbTimestamp(new Date("2026-10-23T19:33:23.456Z"))).toBe("2026-10-23 19:33:23");
    expect(dbTimestamp(Date.parse("2026-01-02T03:04:05Z"))).toBe("2026-01-02 03:04:05");
  });

  it("falls back to now for an invalid value", () => {
    expect(dbTimestamp("garbage")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("parseDbDate", () => {
  it("reads the database shape as UTC, never as local time", () => {
    // The bug this pins: `new Date("2026-10-23 19:33:23")` is parsed as local
    // time, so a suspension applied at 21:33 in Madrid showed as 19:33 in the
    // audit log (and looked like an old entry).
    expect(parseDbDate("2026-10-23 19:33:23")?.toISOString()).toBe("2026-10-23T19:33:23.000Z");
    expect(parseDbDate("2026-10-23T19:33:23.123Z")?.toISOString()).toBe("2026-10-23T19:33:23.123Z");
    expect(parseDbDate("2026-10-23T19:33:23")?.toISOString()).toBe("2026-10-23T19:33:23.000Z");
  });

  it("accepts a plain date and rejects garbage", () => {
    expect(parseDbDate("2026-10-23")?.toISOString()).toBe("2026-10-23T00:00:00.000Z");
    expect(parseDbDate("")).toBeNull();
    expect(parseDbDate("nope")).toBeNull();
    expect(parseDbDate(null)).toBeNull();
  });
});

describe("mixed shapes inside one column", () => {
  it("compares wrongly as raw strings (why the columns are normalised)", () => {
    // 'T' (84) sorts after ' ' (32) at the same date, so an 18:00 row stored in
    // the database shape sorts *below* a 10:00 row stored as ISO: boosts out of
    // order, the same-day dormant-instance scan cutting early. `scripts/…`
    // (`backfill:dates_normalized`) and the writers keep one shape per column.
    expect("2026-10-23 18:00:00" > "2026-10-23T10:00:00.000Z").toBe(false);
    expect("2026-10-23T18:00:00.000Z" > "2026-10-23T10:00:00.000Z").toBe(true);
  });
});
