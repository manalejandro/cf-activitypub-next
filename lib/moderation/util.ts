/**
 * Small helpers shared by the moderation pipeline.
 */

/**
 * Minimal KV shape (the repo's bindings differ from the plain workers types, so
 * every moderation entry point types the binding structurally instead of using
 * the global `KVNamespace` interface).
 */
export interface ModerationKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Resolve the promise but never wait longer than `ms`. */
export async function runWithTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
