/**
 * Intersect requested OAuth scopes with the application's registered scopes so
 * a client cannot obtain more than it registered for. No app scopes / no app
 * means the fallback applies; an empty result falls back to the app's scopes.
 */
export function clampScope(
  requested: string | undefined,
  appScopes: string | undefined,
  fallback: string
): string {
  const allowed = (appScopes ?? "").split(/[\s,]+/).filter(Boolean);
  const asked = (requested ?? "").split(/[\s,]+/).filter(Boolean);
  if (allowed.length === 0) return asked.length ? asked.join(" ") : fallback;
  const granted = asked.length ? asked.filter((s) => allowed.includes(s)) : allowed;
  return (granted.length ? granted : allowed).join(" ");
}
