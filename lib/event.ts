/**
 * Composer "event mode" (ActivityStreams `Event`).
 *
 * A status published with an event becomes an `Event` document instead of a
 * `Note`: federated platforms render the title and the time range, while the
 * status text stays the description. Parsing is shared by the create route and
 * the cron that publishes scheduled statuses.
 */

export interface EventInput {
  name: string;
  /** ISO-8601 instant (the composer sends a `datetime-local` value). */
  startTime: string;
  endTime: string | null;
  location: string | null;
}

/** Longest accepted event title (the composer caps its input too). */
export const MAX_EVENT_NAME_CHARS = 100;
/** Longest accepted venue name. */
export const MAX_EVENT_LOCATION_CHARS = 120;

export type EventParseResult = { event: EventInput | null } | { error: string };

function readString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value.trim();
  }
  return "";
}

/**
 * Parse the `event` field of a status body. Returns `{ event: null }` when the
 * status is not an event, or an i18n `error_code` when the object is malformed
 * or its time range is impossible (a title and a valid start are required).
 */
export function parseEventInput(raw: unknown): EventParseResult {
  if (raw === undefined || raw === null || raw === "") return { event: null };
  if (typeof raw !== "object") return { error: "compose_error_event" };
  const record = raw as Record<string, unknown>;
  const name = readString(record, "name").slice(0, MAX_EVENT_NAME_CHARS);
  if (!name) return { error: "compose_error_event_title" };
  const startRaw = readString(record, "start_time", "startTime");
  if (!startRaw) return { error: "compose_error_event_start" };
  const start = new Date(startRaw);
  if (Number.isNaN(start.getTime())) return { error: "compose_error_event_start" };
  const endRaw = readString(record, "end_time", "endTime");
  let endTime: string | null = null;
  if (endRaw) {
    const end = new Date(endRaw);
    if (Number.isNaN(end.getTime()) || end.getTime() < start.getTime()) return { error: "compose_error_event_end" };
    endTime = end.toISOString();
  }
  const location = readString(record, "location").slice(0, MAX_EVENT_LOCATION_CHARS);
  return { event: { name, startTime: start.toISOString(), endTime, location: location || null } };
}

/**
 * Read the event of a stored ActivityPub document. An edit rebuilds the
 * document from the new text, so the title and time range have to come back
 * from the stored one or the status would lose its `Event` shape.
 */
export function eventFromRaw(raw: string | null | undefined): EventInput | null {
  if (!raw) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || doc.type !== "Event") return null;
  const name = typeof doc.name === "string" ? doc.name : "";
  const startTime = typeof doc.startTime === "string" ? doc.startTime : "";
  if (!name || !startTime) return null;
  const locationValue = doc.location;
  const location = typeof locationValue === "string"
    ? locationValue
    : locationValue && typeof locationValue === "object" && typeof (locationValue as Record<string, unknown>).name === "string"
      ? String((locationValue as Record<string, unknown>).name)
      : "";
  return {
    name,
    startTime,
    endTime: typeof doc.endTime === "string" ? doc.endTime : null,
    location: location || null,
  };
}
