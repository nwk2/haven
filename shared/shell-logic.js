// Haven shell logic — pure helpers, no DOM access, so they can be tested in
// Node (scripts/smoke-test.mjs). The browser wiring lives in /app.js.
// Batch 1.

export function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Theme (spec §2): a stored choice wins; otherwise follow the system.
export function resolveTheme(stored, prefersDark) {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function greetingFor(date) {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function formatHomeDate(date) {
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Google sign-in URL (Batch 2): authorization-code flow. The client ID is
// public by design; the redirect URI is the app root — it must match one of
// the URIs registered in Google Cloud Console exactly, and the Worker uses
// the same value when it exchanges the code. `state` is a one-time CSRF
// nonce the caller stores (localStorage, so it survives the round-trip
// even if iOS relaunches the PWA on the way back from Google).
export function googleAuthUrl(clientId, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

// Module chunk URL, derived from the registry route prefix (spec §3).
export function chunkUrl(routePrefix) {
  const prefix = routePrefix.endsWith("/") ? routePrefix : routePrefix + "/";
  return prefix + "chunk.js";
}

// Widget feed order (spec §4): module-declared priority, time-sensitive
// first; ties keep registry order. Modules with no widget (priority null)
// are excluded. Array.sort is stable, so equal priorities keep order.
export function sortWidgets(modules) {
  return modules
    .map((mod, index) => ({ mod, index }))
    .filter(({ mod }) => mod.widget_priority !== null && mod.widget_priority !== undefined)
    .sort((a, b) => a.mod.widget_priority - b.mod.widget_priority || a.index - b.index)
    .map(({ mod }) => mod);
}

// Icons, keyed by the registry icon name. Modules supply the name; the
// shell renders it at a fixed size. Unknown names get the fallback glyph.
const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const ICONS = {
  home: `${SVG_OPEN}<path d="M3.5 11 12 3.5 20.5 11"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/></svg>`,
  kitchen: `${SVG_OPEN}<path d="M4 11h16v2.5A5.5 5.5 0 0 1 14.5 19h-5A5.5 5.5 0 0 1 4 13.5V11Z"/><path d="M8 11V8h8v3"/><path d="M2 11h2M20 11h2"/><path d="M10 4.5c0-1 .8-1 .8-2M14 4.5c0-1 .8-1 .8-2"/></svg>`,
  test: `${SVG_OPEN}<path d="M9 3h6"/><path d="M10 3v5.5L4.5 18a2 2 0 0 0 1.8 3h11.4a2 2 0 0 0 1.8-3L14 8.5V3"/><path d="M7.5 14h9"/></svg>`,
  sun: `${SVG_OPEN}<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>`,
  moon: `${SVG_OPEN}<path d="M20 13.5A8.5 8.5 0 0 1 10.5 4 8.5 8.5 0 1 0 20 13.5Z"/></svg>`,
  fallback: `${SVG_OPEN}<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>`,
};

export function iconSVG(name) {
  return ICONS[name] || ICONS.fallback;
}

// Home-screen tile (spec §4): icon, name and a one-line description of the
// module's job. The description comes from the module's chunk export.
export function tileHTML(mod, description) {
  return `<a class="tile" href="${escapeHTML(mod.route_prefix)}" data-route="${escapeHTML(mod.module_id)}">`
    + `<span class="tile-icon">${iconSVG(mod.icon)}</span>`
    + `<span><span class="tile-name">${escapeHTML(mod.name)}</span>`
    + `<span class="tile-desc">${escapeHTML(description || "")}</span></span></a>`;
}

// Widget card (spec §4). Title/body are plain text; href is the module
// route the widget deep-links into.
export function widgetHTML(widget, moduleId) {
  return `<a class="widget" href="${escapeHTML(widget.href)}" data-route="${escapeHTML(moduleId)}">`
    + `<span class="widget-title">${escapeHTML(widget.title)}</span>`
    + `<span class="widget-body">${escapeHTML(widget.body)}</span></a>`;
}

// Collect the widget feed (spec §4): for each module with a widget, in
// priority order, load its chunk and render the widget. A widget that
// errors — or a chunk that fails to load — is hidden (failure isolation,
// spec §3); the tile still opens the module. `loadChunk` is injected so
// this can be tested in Node.
export async function collectWidgets(modules, loadChunk) {
  const rendered = [];
  for (const mod of sortWidgets(modules)) {
    try {
      const chunk = await loadChunk(mod);
      if (typeof chunk.widget !== "function") continue;
      const widget = await chunk.widget();
      if (widget) rendered.push(widgetHTML(widget, mod.module_id));
    } catch (err) {
      console.warn("widget failed for module " + mod.module_id, err);
    }
  }
  return rendered;
}

// Collect the tiles (spec §4), one per registered module, in registry
// order. The description comes from the module's chunk; a chunk that fails
// to load still gets its tile, with a fallback description.
export async function collectTiles(modules, loadChunk) {
  const tiles = [];
  for (const mod of modules) {
    let description = "Open the module";
    try {
      const chunk = await loadChunk(mod);
      if (typeof chunk.description === "string" && chunk.description) {
        description = chunk.description;
      }
    } catch (err) {
      console.warn("chunk failed for module " + mod.module_id, err);
    }
    tiles.push(tileHTML(mod, description));
  }
  return tiles;
}
