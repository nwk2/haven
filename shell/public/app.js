// Haven shell app — Batch 0 scaffold. No framework yet; Batch 1 builds the
// shell UI (Editorial tokens, registry-driven home screen) on this router.
//
// Kitchen is lazy-loaded: its chunk only downloads when the user opens
// /kitchen/. That is the per-module route chunk from spec §11.
const app = document.getElementById("app");

function home() {
  app.innerHTML =
    "<h1>Haven</h1><p>One household app. Kitchen is module 1.</p>";
}

async function openKitchen() {
  const mod = await import("/kitchen/chunk.js");
  mod.mountKitchen(app);
}

function route() {
  if (window.location.pathname.startsWith("/kitchen")) {
    void openKitchen();
  } else {
    home();
  }
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link) return;
  event.preventDefault();
  window.history.pushState(null, "", link.getAttribute("href"));
  route();
});

window.addEventListener("popstate", route);
route();
