import { describe, expect, it } from "vitest";
import { eventFromRaw, MAX_EVENT_LOCATION_CHARS, MAX_EVENT_NAME_CHARS, parseEventInput } from "@/lib/event";

const START = "2026-11-20T19:00:00.000Z";
const END = "2026-11-20T21:30:00.000Z";

describe("parseEventInput", () => {
  it("treats an absent event as a plain status", () => {
    expect(parseEventInput(undefined)).toEqual({ event: null });
    expect(parseEventInput(null)).toEqual({ event: null });
    expect(parseEventInput("")).toEqual({ event: null });
  });

  it("normalizes the instants and keeps the venue", () => {
    const result = parseEventInput({
      name: "  Festival  ",
      start_time: START,
      end_time: END,
      location: "  Parque Central ",
    });
    expect(result).toEqual({
      event: { name: "Festival", startTime: START, endTime: END, location: "Parque Central" },
    });
  });

  it("accepts camelCase keys and an event without an end", () => {
    expect(parseEventInput({ name: "Charla", startTime: START })).toEqual({
      event: { name: "Charla", startTime: START, endTime: null, location: null },
    });
  });

  it("parses a local-time value (the composer's datetime-local)", () => {
    const result = parseEventInput({ name: "Cine", start_time: "2026-11-20T19:00" });
    expect(result).toEqual({ event: { name: "Cine", startTime: new Date("2026-11-20T19:00").toISOString(), endTime: null, location: null } });
  });

  it("reports the missing or impossible pieces", () => {
    expect(parseEventInput("Festival")).toEqual({ error: "compose_error_event" });
    expect(parseEventInput({ start_time: START })).toEqual({ error: "compose_error_event_title" });
    expect(parseEventInput({ name: "  " })).toEqual({ error: "compose_error_event_title" });
    expect(parseEventInput({ name: "Sin fecha" })).toEqual({ error: "compose_error_event_start" });
    expect(parseEventInput({ name: "Rota", start_time: "mañana" })).toEqual({ error: "compose_error_event_start" });
    expect(parseEventInput({ name: "Al revés", start_time: END, end_time: START })).toEqual({ error: "compose_error_event_end" });
    expect(parseEventInput({ name: "Rota", start_time: START, end_time: "ayer" })).toEqual({ error: "compose_error_event_end" });
  });

  it("caps the title and the venue", () => {
    const result = parseEventInput({
      name: "n".repeat(MAX_EVENT_NAME_CHARS + 20),
      start_time: START,
      location: "l".repeat(MAX_EVENT_LOCATION_CHARS + 20),
    });
    if (!("event" in result) || !result.event) throw new Error("expected an event");
    expect(result.event.name).toHaveLength(MAX_EVENT_NAME_CHARS);
    expect(result.event.location).toHaveLength(MAX_EVENT_LOCATION_CHARS);
  });
});

describe("eventFromRaw", () => {
  it("reads the event back from a stored document", () => {
    const raw = JSON.stringify({
      type: "Event",
      name: "Festival",
      startTime: START,
      endTime: END,
      location: { type: "Place", name: "Parque Central", latitude: 40.4, longitude: -3.7 },
    });
    expect(eventFromRaw(raw)).toEqual({
      name: "Festival",
      startTime: START,
      endTime: END,
      location: "Parque Central",
    });
  });

  it("ignores anything that is not an event", () => {
    expect(eventFromRaw(null)).toBeNull();
    expect(eventFromRaw("not json")).toBeNull();
    expect(eventFromRaw(JSON.stringify({ type: "Note", content: "hola" }))).toBeNull();
    expect(eventFromRaw(JSON.stringify({ type: "Event", startTime: START }))).toBeNull();
  });
});
