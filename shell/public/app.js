// Haven shell app — Batch 1. Registry-driven home screen, Editorial themes,
// shell chrome (header Home control + bottom navigation). No framework; the
// shell owns the router, modules own everything below their prefix.
//
// Module client-chunk contract (spec §3): each chunk exports
//   description — one-line job description for the tile
//   mount(el)   — mount the module screen
//   widget()    — async; null when empty, or { title, body, href }
// The shell never reads a module's tables; the widget is the module's own
// summary, rendered by the shell. A widget that errors is hidden; the tile
// still opens the module (failure isolation, spec §3).
import {
  resolveTheme,
  greetingFor,
  formatHomeDate,
  chunkUrl,
  collectWidgets,
  collectTiles,
  iconSVG,
  escapeHTML,
} from "/shell-logic.js";

const app = document.getElementById("app");
const bottomNav = document.getElementById("bottomnav");
const themeToggle = document.getElementById("theme-toggle");

let modulesCache = null; // registry, fetched once from /api/modules

// --- Theme: stored choice wins, otherwise follow the system (spec §2). ---
function systemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function storedTheme() {
  try {
    return localStorage.getItem("haven-theme");
  } catch {
    return null;
  }
}
function currentTheme() {
  return resolveTheme(storedTheme(), systemPrefersDark());
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.innerHTML = iconSVG(theme === "dark" ? "sun" : "moon");
  themeToggle.setAttribute(
    "aria-label",
    theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
  );
}
themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem("haven-theme", next);
  } catch {
    // Private mode: the theme still switches for this session.
  }
  applyTheme(next);
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!storedTheme()) applyTheme(resolveTheme(null, systemPrefersDark()));
});
applyTheme(currentTheme());

document.getElementById("home-control").addEventListener("click", () => {
  window.history.pushState(null, "", "/");
  void route();
});

async function loadModules() {
  if (modulesCache) return modulesCache;
  const res = await fetch("/api/modules");
  if (!res.ok) throw new Error("modules request failed: " + res.status);
  const data = await res.json();
  if (!data.ok || !Array.isArray(data.modules)) throw new Error("modules request failed");
  modulesCache = data.modules;
  return modulesCache;
}

function loadChunk(mod) {
  return import(chunkUrl(mod.route_prefix));
}

function renderBottomNav(activeId) {
  const items = [
    { module_id: "home", name: "Home", icon: "home", route_prefix: "/" },
    ...modulesCache,
  ];
  bottomNav.innerHTML = items
    .map((item) => {
      const active = item.module_id === activeId
        ? ' class="active" aria-current="page"'
        : "";
      return `<a href="${escapeHTML(item.route_prefix)}" data-route="${escapeHTML(item.module_id)}"${active}>`
        + `${iconSVG(item.icon)}<span>${escapeHTML(item.name)}</span></a>`;
    })
    .join("");
}

async function renderHome() {
  const now = new Date();
  let html = `<p class="greeting">${greetingFor(now)}</p>`
    + `<p class="home-date">${formatHomeDate(now)}</p>`;

  // Widget feed first (what is relevant now), then the stable launcher.
  const widgets = await collectWidgets(modulesCache, loadChunk);
  if (widgets.length > 0) {
    html += `<section class="widget-feed" aria-label="Updates">${widgets.join("")}</section>`;
  }

  const tiles = await collectTiles(modulesCache, loadChunk);
  html += `<h2 class="section-head">Modules</h2>`
    + `<section class="tile-grid">${tiles.join("")}</section>`;
  app.innerHTML = html;
  renderBottomNav("home");
}

async function openModule(mod) {
  app.innerHTML = `<div class="empty-state"><p>Loading ${escapeHTML(mod.name)}…</p></div>`;
  renderBottomNav(mod.module_id);
  try {
    const chunk = await loadChunk(mod);
    app.innerHTML = "";
    chunk.mount(app);
  } catch (err) {
    console.warn("module failed to load: " + mod.module_id, err);
    app.innerHTML = `<div class="empty-state"><h2>${escapeHTML(mod.name)} couldn’t load</h2>`
      + `<p>Something went wrong opening this module.</p>`
      + `<p><button class="btn btn-primary" id="retry-module" type="button">Try again</button></p></div>`;
    document.getElementById("retry-module").addEventListener("click", () => void route());
  }
}

async function route() {
  let modules;
  try {
    modules = await loadModules();
  } catch (err) {
    console.warn("registry unavailable", err);
    app.innerHTML = `<div class="empty-state"><h2>Couldn’t load Haven</h2>`
      + `<p>The module list didn’t load. Check your connection and try again.</p>`
      + `<p><button class="btn btn-primary" id="retry-home" type="button">Try again</button></p></div>`;
    document.getElementById("retry-home").addEventListener("click", () => {
      modulesCache = null;
      void route();
    });
    return;
  }
  const path = window.location.pathname;
  const mod = modules.find(
    (m) => path === m.route_prefix
      || path === m.route_prefix.replace(/\/$/, "")
      || path.startsWith(m.route_prefix),
  );
  if (mod) {
    await openModule(mod);
    return;
  }
  await renderHome();
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link) return;
  event.preventDefault();
  window.history.pushState(null, "", link.getAttribute("href"));
  void route();
});

window.addEventListener("popstate", () => void route());
void route();
