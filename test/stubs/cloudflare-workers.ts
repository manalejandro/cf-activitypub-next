/**
 * jsdom stub for `cloudflare:workers` (unit project only).
 *
 * The real module only exists inside workerd; vitest.config.mts maps the
 * specifier here for the jsdom project. Tests override `env` with `vi.mock`
 * (bindings are mocked per test).
 */
export const env: Record<string, unknown> = {};
