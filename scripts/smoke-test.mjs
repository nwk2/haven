// Node smoke tests for the pure shell logic (shared/shell-logic.js).
//
//   node scripts/smoke-test.mjs
//     Pure-logic checks only.
//
//   node scripts/smoke-test.mjs --modules-url <base>
//     Also fetches /api/modules from a running server (local wrangler dev
//     or the live Worker) and runs the renderers over the real registry
//     data; for each module it fetches the live chunk, imports it, and
//     checks the contract (description string, mount function, widget()
//     returning null or { title, body, href }).
//
// Exit code is non-zero on any failure.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveTheme,
  greetingFor,
  formatHomeDate,
  chunkUrl,
  sortWidgets,
  tileHTML,
  widgetHTML,
  collectWidgets,
  collectTiles,
  iconSVG,
  escapeHTML,
  googleAuthUrl,
} from "../shared/shell-logic.js";

let failures = 0;

function check(name, actual, expected) {
  if (actual !== expected) {
    failures++;
    console.error(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok ${name}`);
  }
}

function checkContains(name, haystack, needle) {
  if (typeof haystack !== "string" || !haystack.includes(needle)) {
    failures++;
    console.error(`FAIL ${name}\n  missing: ${JSON.stringify(needle)}\n  in: ${JSON.stringify(haystack)}`);
  } else {
    console.log(`ok ${name}`);
  }
}

// --- Pure logic ---

// Theme: stored choice wins, otherwise follow the system (spec §2).
check("theme: stored dark beats light system", resolveTheme("dark", false), "dark");
check("theme: stored light beats dark system", resolveTheme("light", true), "light");
check("theme: no stored value follows dark system", resolveTheme(null, true), "dark");
check("theme: no stored value follows light system", resolveTheme(null, false), "light");
check("theme: garbage stored value falls back to system", resolveTheme("sepia", true), "dark");

// Greeting + date (fixed local times, so no timezone dependence).
check("greeting: 08:30 is morning", greetingFor(new Date(2026, 10, 20, 8, 30)), "Good morning");
check("greeting: 13:00 is afternoon", greetingFor(new Date(2026, 10, 20, 13, 0)), "Good afternoon");
check("greeting: 20:00 is evening", greetingFor(new Date(2026, 10, 20, 20, 0)), "Good evening");
check("date: 20 Nov 2026", formatHomeDate(new Date(2026, 10, 20, 12, 0)), "Friday, 20 November 2026");

// Chunk URLs derive from the registry route prefix.
check("chunkUrl: trailing slash", chunkUrl("/kitchen/"), "/kitchen/chunk.js");
check("chunkUrl: no trailing slash", chunkUrl("/kitchen"), "/kitchen/chunk.js");

// Widget feed order (spec §4): priority first, ties keep registry order,
// no-priority modules excluded.
const feed = sortWidgets([
  { module_id: "b", widget_priority: 2 },
  { module_id: "a", widget_priority: null },
  { module_id: "c", widget_priority: 1 },
  { module_id: "d", widget_priority: 1 },
]);
check("widgets: priority order, ties keep registry order",
  feed.map((m) => m.module_id).join(","), "c,d,b");

// Escaping + renderers.
check("escape: quotes and brackets", escapeHTML('<a href="x">&\'y\'</a>'),
  "&lt;a href=&quot;x&quot;&gt;&amp;&#39;y&#39;&lt;/a&gt;");
const tile = tileHTML(
  { module_id: "kitchen", name: "Kitchen", icon: "kitchen", route_prefix: "/kitchen/" },
  "Plan the week’s meals.",
);
checkContains("tile: name", tile, "Kitchen");
checkContains("tile: description", tile, "Plan the week’s meals.");
checkContains("tile: link", tile, 'href="/kitchen/"');
checkContains("tile: svg icon", tile, "<svg");
checkContains("tile: route marker", tile, 'data-route="kitchen"');
const widget = widgetHTML({ title: "Next meal", body: "Dinner at 7", href: "/kitchen/" }, "kitchen");
checkContains("widget: title", widget, "Next meal");
checkContains("widget: body", widget, "Dinner at 7");
checkContains("widget: deep link", widget, 'href="/kitchen/"');
checkContains("icon: kitchen is svg", iconSVG("kitchen"), "<svg");
checkContains("icon: unknown name falls back", iconSVG("nope"), "<svg");

// Failure isolation (spec §3): a throwing widget hides, a null widget
// hides, the good widget still renders; a throwing chunk still gets a
// tile, with the fallback description.
const fakeLoader = async (mod) => {
  if (mod.module_id === "boom") throw new Error("boom");
  if (mod.module_id === "good") {
    return { description: "Good module.", widget: async () => ({ title: "Hi", body: "There", href: "/good/" }) };
  }
  return { description: "Empty module.", widget: async () => null };
};
const isoWidgets = await collectWidgets([
  { module_id: "good", widget_priority: 1 },
  { module_id: "boom", widget_priority: 2 },
  { module_id: "empty", widget_priority: 3 },
  { module_id: "nowidget", widget_priority: null },
], fakeLoader);
check("isolation: only the good widget renders", isoWidgets.length, 1);
checkContains("isolation: good widget content", isoWidgets[0] || "", "Hi");
const isoTiles = await collectTiles([
  { module_id: "good", name: "Good", icon: "test", route_prefix: "/good/" },
  { module_id: "boom", name: "Boom", icon: "test", route_prefix: "/boom/" },
], fakeLoader);
check("isolation: both tiles render", isoTiles.length, 2);
checkContains("isolation: good tile description", isoTiles[0], "Good module.");
checkContains("isolation: broken tile falls back", isoTiles[1], "Open the module");

// Google sign-in URL (Batch 2): authorization-code flow, app root as the
// redirect URI, one-time state nonce.
const gUrl = googleAuthUrl(
  "710021216622-xxx.apps.googleusercontent.com",
  "https://haven.wk-io.workers.dev/",
  "state-1",
);
checkContains("googleAuthUrl: host", gUrl, "https://accounts.google.com/o/oauth2/v2/auth?");
checkContains("googleAuthUrl: client id", gUrl, "client_id=710021216622-xxx.apps.googleusercontent.com");
checkContains("googleAuthUrl: redirect uri", gUrl, "redirect_uri=https%3A%2F%2Fhaven.wk-io.workers.dev%2F");
checkContains("googleAuthUrl: code flow", gUrl, "response_type=code");
checkContains("googleAuthUrl: scopes", gUrl, "scope=openid+email+profile");
checkContains("googleAuthUrl: state", gUrl, "state=state-1");
checkContains("googleAuthUrl: prompt", gUrl, "prompt=select_account");

// --- Live registry data (optional) ---
const urlArg = process.argv.indexOf("--modules-url");
if (urlArg !== -1) {
  const base = process.argv[urlArg + 1].replace(/\/$/, "");
  // Batch 2: /api/modules requires a session + household membership.
  // With HAVEN_TOKEN set, the full live checks run; without one, the
  // gate itself is the check — an unauthenticated call must be 401.
  const token = process.env.HAVEN_TOKEN || null;
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${base}/api/modules`, { headers: authHeaders });
  if (!token) {
    check("live: /api/modules without a session is 401", res.status, 401);
    const unauth = await fetch(`${base}/api/me`, { headers: authHeaders });
    check("live: /api/me without a session is 401", unauth.status, 401);
  } else {
    check("live: /api/modules is 200", res.status, 200);
    const data = await res.json();
    check("live: /api/modules ok", data.ok, true);
    if (!Array.isArray(data.modules) || data.modules.length === 0) {
      failures++;
      console.error("FAIL live: registry returned no modules");
    } else {
      console.log(`ok live: registry has ${data.modules.length} module(s): ${data.modules.map((m) => m.module_id).join(", ")}`);
      const tmp = await mkdtemp(join(tmpdir(), "haven-chunks-"));
      try {
        for (const mod of data.modules) {
          const chunkRes = await fetch(`${base}${chunkUrl(mod.route_prefix)}`);
          check(`live: chunk ${mod.module_id} is 200`, chunkRes.status, 200);
          const file = join(tmp, `${mod.module_id}-chunk.mjs`);
          await writeFile(file, await chunkRes.text());
          const chunk = await import(pathToFileURL(file).href);
          check(`live: chunk ${mod.module_id} exports a description`, typeof chunk.description, "string");
          check(`live: chunk ${mod.module_id} exports mount`, typeof chunk.mount, "function");
          check(`live: chunk ${mod.module_id} exports widget`, typeof chunk.widget, "function");
          const w = await chunk.widget();
          if (w === null) {
            console.log(`ok live: widget ${mod.module_id} is empty (null) — hides`);
          } else {
            check(`live: widget ${mod.module_id} has a title`, typeof w.title, "string");
            check(`live: widget ${mod.module_id} has a body`, typeof w.body, "string");
            check(`live: widget ${mod.module_id} has an href`, typeof w.href, "string");
          }
          const html = tileHTML(mod, chunk.description);
          checkContains(`live: tile ${mod.module_id} renders its name`, html, mod.name);
        }
        const order = sortWidgets(data.modules).map((m) => m.module_id).join(",");
        console.log(`ok live: widget feed order is [${order}]`);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke test passed");
