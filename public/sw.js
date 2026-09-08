/* CF ActivityPub service worker — PWA offline support.
 *
 * Cache strategy:
 *  - `/_next/static/*` and `/swagger-ui/*`: immutable build assets → cache-first.
 *  - navigation requests (HTML): network-first, falling back to the cached
 *    app shell so the UI opens offline.
 *  - everything else (REST API, media, federation, streaming): network-only —
 *    this is a real-time social app and cached API responses would go stale.
 */
const STATIC_CACHE = "cfap-static-v1";
const SHELL_CACHE = "cfap-shell-v1";

// Bump when the worker's behaviour changes (e.g. the push handler) so the
// active version is visible in the browser's service worker debugger and in
// `navigator.serviceWorker.controller` logs.
const SW_VERSION = "2026.09.2";

const STATIC_PREFIXES = ["/_next/static/", "/swagger-ui/", "/icons/", "/logo.svg"];

self.addEventListener("install", (event) => {
  // Pre-cache the app shell, but NEVER let a failing URL block activation —
  // `skipWaiting` must always run so a newly deployed SW (e.g. one that adds a
  // push handler) takes over immediately. Otherwise the browser keeps the old
  // SW and push notifications stay dead until a successful install.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(["/", "/login", "/explore", "/manifest.json"].map((u) => cache.add(u)))
      )
      .finally(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== SHELL_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ── Web Push notifications ────────────────────────────────────────────────
 * The server delivers an encrypted JSON payload: { title, body, icon, badge,
 * tag, sound, data }. We show the notification here (service workers are the
 * only place that can), and — when the user enabled the sound preference —
 * ask any open page to play /notification.ogg (a service worker itself cannot
 * play audio; only a window can).
 */
const notificationUrl = (type, data) => {
  if (type === "direct" || type === "encrypted") return "/messages";
  if (data && data.notification_id) return "/notifications";
  return "/";
};

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch { /* empty / non-JSON payload */ }
  const type = (payload.data && payload.data.type) || "";
  const origin = self.location.origin;
  const options = {
    body: payload.body || "",
    icon: payload.icon ? new URL(payload.icon, origin).href : `${origin}/logo.svg`,
    badge: payload.badge ? new URL(payload.badge, origin).href : `${origin}/logo.svg`,
    tag: payload.tag || `cfap-notif-${type}`,
    renotify: true,
    data: payload.data || {},
  };
  event.waitUntil(
    Promise.resolve()
      .then(() => self.registration.showNotification(payload.title || "CF ActivityPub", options))
      .catch((err) => console.warn("[sw] showNotification failed:", err))
      .then(() =>
        // Always tell open windows a notification arrived (badge + UI refresh);
        // the sound flag lets them play the chime.
        self.clients
          .matchAll({ type: "window", includeUncontrolled: true })
          .then((clients) => {
            for (const client of clients) {
              client.postMessage({ type: "cfap:notification", sound: !!payload.sound });
            }
          })
          .catch(() => {})
      )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = notificationUrl(event.notification.data && event.notification.data.type, data);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          if (client.navigate && client.url !== new URL(url, self.location.origin).href) {
            return client.navigate(url);
          }
          return undefined;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Streaming / WebSocket / EventSource upgrades must never be intercepted.
  if (request.headers.get("upgrade") || url.pathname.startsWith("/api/v1/streaming")) {
    return;
  }

  // Immutable static assets: cache-first, background refresh.
  if (STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // App shell (navigations): network-first, offline fallback to cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/"))
        )
    );
    return;
  }

  // Everything else (API, media, federation): network-only.
});