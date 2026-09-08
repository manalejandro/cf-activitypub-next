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

const STATIC_PREFIXES = ["/_next/static/", "/swagger-ui/", "/icons/", "/logo.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(["/", "/login", "/explore", "/manifest.json"]))
      .then(() => self.skipWaiting())
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
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/logo.svg",
    badge: payload.badge || "/logo.svg",
    tag: payload.tag || `cfap-notif-${type}`,
    renotify: true,
    data: payload.data || {},
  };
  event.waitUntil(
    self.registration.showNotification(payload.title || "CF ActivityPub", options).then(() => {
      if (payload.sound) {
        // Best-effort: tell open windows to play the notification chime.
        return self.clients
          .matchAll({ type: "window", includeUncontrolled: true })
          .then((clients) => {
            for (const client of clients) {
              client.postMessage({ type: "cfap:notification-sound" });
            }
          })
          .catch(() => {});
      }
    })
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