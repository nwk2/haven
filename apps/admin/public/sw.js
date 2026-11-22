// Haven admin service worker (decision, Nov 2026: installable, nothing cached).
// It stores nothing: no Cache Storage, no copies of pages or data. Its only job is to make the
// site installable and to show a plain offline screen when a page can't be loaded.
// API and sign-in requests are never touched. The offline screen draws its icon inline,
// because nothing (not even the icon file) is stored for offline use.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Haven admin · Offline</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box;
         background: #111413; color: #EEF2EE; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; }
  h1 { font-size: 22px; margin: 16px 0 8px; } p { color: #9AA59E; margin: 0 0 20px; line-height: 1.5; }
  button { min-height: 44px; padding: 0 20px; border-radius: 22px; border: 1px solid #9AA59E; background: transparent; color: #EEF2EE; font: inherit; font-weight: 600; }
</style></head><body><main>
  <svg width="64" height="64" viewBox="0 0 1024 1024" aria-hidden="true" style="border-radius:14px"><rect width="1024" height="1024" fill="#1D221E"/><g transform="translate(512 455) scale(0.82) translate(-512 -524)"><path d="M232 500L512 268L792 500" fill="none" stroke="#C6F36B" stroke-width="88" stroke-linecap="round" stroke-linejoin="round"/><path d="M392 780V600a120 120 0 0 1 240 0V780Z" fill="#C6F36B"/><circle cx="512" cy="640" r="46" fill="#1D221E"/></g><rect x="282" y="690" width="460" height="112" rx="56" fill="#C6F36B"/></svg>
  <h1>You’re offline</h1>
  <p>Admin only shows live data, so nothing is saved on this device.<br>Reconnect and try again.</p>
  <button onclick="location.reload()">Try again</button>
</main></body></html>`;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only page loads on this site; everything else (API, sign-in, assets) goes to the network untouched.
  // Navigations carrying an OAuth code/error are also left alone: the Worker answers those with a
  // redirect, and Safari refuses a service-worker-served response that went through one.
  if (req.mode !== "navigate" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.searchParams.has("code") || url.searchParams.has("error")) return;
  event.respondWith(fetch(req).catch(() => new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })));
});
