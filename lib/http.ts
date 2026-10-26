/**
 * HTTP helpers shared by the outbound federation/cache code.
 */

/**
 * Release the body of a Response we don't plan to read.
 *
 * Cloudflare caps the number of in-flight fetches; leaving response bodies
 * unread stalls them until the runtime cancels the oldest one ("A stalled HTTP
 * response was canceled to prevent deadlock"). Call this on every non-ok /
 * discarded response before returning or trying another user agent.
 */
export async function discardBody(res: Response | null | undefined): Promise<void> {
  try {
    await res?.body?.cancel();
  } catch {
    /* already consumed or closed */
  }
}

/**
 * Read at most `max` bytes of a response (or request) body — bounded memory.
 * Returns null when the body exceeds the cap (the reader is cancelled, so the
 * oversized body never lands in the isolate and the fetch slot is released).
 */
export async function readBoundedBytes(
  res: Pick<Response, "body" | "arrayBuffer">,
  max: number
): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buffer = await res.arrayBuffer().catch(() => null);
    if (!buffer || buffer.byteLength > max) return null;
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Read at most `max` bytes of a body as UTF-8 text; null when oversized/unreadable. */
export async function readBoundedText(
  res: Pick<Response, "body" | "arrayBuffer">,
  max: number
): Promise<string | null> {
  const bytes = await readBoundedBytes(res, max);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

/**
 * Parse at most `max` bytes of a body as JSON. `res.json()` on a malicious
 * multi-hundred-MB body would exhaust the Worker's memory before any size
 * check could run, so every remote document read goes through here; null on
 * oversize or invalid JSON.
 */
export async function readBoundedJson<T>(
  res: Pick<Response, "body" | "arrayBuffer">,
  max: number
): Promise<T | null> {
  const text = await readBoundedText(res, max);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
