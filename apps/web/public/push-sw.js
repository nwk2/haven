// Haven push handler, imported into the generated service worker (vite.config.ts › workbox.importScripts).
// Shows reminders and opens the right screen when one is tapped (PRD › To-dos plan › Notifications).
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "Haven", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "Haven", {
    body: d.body || "",
    tag: d.tag,                       // same tag replaces, so a reminder never shows twice
    data: { url: d.url || "/" },
    icon: "/icon-192-maskable.png",
    badge: "/haven-glyph-monochrome.svg",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) if (new URL(w.url).origin === self.location.origin) { await w.focus(); if ("navigate" in w) await w.navigate(url); return; }
    await self.clients.openWindow(url);
  })());
});
