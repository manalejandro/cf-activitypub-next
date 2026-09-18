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
