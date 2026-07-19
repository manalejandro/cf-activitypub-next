self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "ActivityPub" };
  try {
    data = event.data ? event.data.json() : data;
  } catch {}
  const { title, body, icon, badge, image, tag, url } = data;
  event.waitUntil(
    self.registration.showNotification(title || "ActivityPub", {
      body,
      icon: icon || "/icon.png",
      badge: badge || "/badge.png",
      image,
      tag,
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      const existing = windowClients.find((c) => c.url === url);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
