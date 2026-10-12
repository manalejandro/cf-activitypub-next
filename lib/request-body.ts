/**
 * Request bodies as Rails parses them.
 *
 * Clients built against the Mastodon API send form-encoded bodies using Rails'
 * array/nested conventions — `media_ids[]=1&media_ids[]=2`,
 * `poll[options][]=a&poll[expires_in]=3600`, `push[data][alerts][follow]=true`.
 * `Object.fromEntries` kept those keys verbatim (`"media_ids[]"`), so
 * `body.media_ids` was undefined and a status published by Tusky came out with
 * no attachments. JSON bodies are returned untouched.
 */

export function formDataToBody(form: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue; // files: the caller handles them
    assign(body, keySegments(key), value);
  }
  return body;
}

/** Read a JSON or form-encoded request body into a plain object. */
export async function readRequestBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return (await request.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  try {
    return formDataToBody(await request.formData());
  } catch {
    return {};
  }
}

/** `poll[options][]` → `["poll", "options", null]` (null appends to an array). */
function keySegments(key: string): (string | null)[] {
  const bracket = key.indexOf("[");
  if (bracket === -1) return [key];
  const segments: (string | null)[] = [key.slice(0, bracket)];
  for (const match of key.slice(bracket).matchAll(/\[([^\]]*)\]/g)) {
    segments.push(match[1] === "" ? null : match[1]);
  }
  return segments;
}

function assign(container: Record<string, unknown> | unknown[], segments: (string | null)[], value: string): void {
  const [segment, ...rest] = segments;
  if (segment === null) {
    const list = container as unknown[];
    if (rest.length === 0) {
      list.push(value);
      return;
    }
    const child: Record<string, unknown> | unknown[] = rest[0] === null ? [] : {};
    list.push(child);
    assign(child, rest, value);
    return;
  }
  const record = container as Record<string, unknown>;
  if (rest.length === 0) {
    record[segment] = value;
    return;
  }
  const existing = record[segment];
  const child =
    existing !== null && typeof existing === "object"
      ? (existing as Record<string, unknown> | unknown[])
      : rest[0] === null
        ? []
        : {};
  record[segment] = child;
  assign(child, rest, value);
}
