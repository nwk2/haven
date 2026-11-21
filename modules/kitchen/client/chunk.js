// Kitchen module client chunk — Batch 3: Recipes, Plan, Today.
// Shop and Pantry arrive in Batch 4 (empty states only here).
// The server (modules/kitchen/server/routes.ts) is the source of truth
// for the API contract; this file only renders it.
//
// Chunk contract (spec §3): description, mount(el), widget().
// No top-level DOM or localStorage access — everything runs inside
// functions, so the smoke test can import this file in Node.
import { escapeHTML } from "/shell-logic.js";
import { openSheet, confirmPrompt } from "/components.js";

export const description = "Plan the week’s meals and the shopping that follows.";

const SESSION_KEY = "haven-session";
const API_TIMEOUT_MS = 15000;
const MEALS = ["breakfast", "lunch", "dinner"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// --- Dates (local device time; the server works in YYYY-MM-DD) ---
function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}
function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localTodayStr() {
  return fmtLocal(new Date());
}
function mondayStrOf(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return null;
  const diff = (d.getDay() + 6) % 7; // days since Monday
  return fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff));
}
function addDaysStr(dateStr, n) {
  const d = parseLocalDate(dateStr);
  if (!d) return null;
  return fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}
function weekdayShort(dateStr) {
  const d = parseLocalDate(dateStr);
  return d ? WEEKDAY_SHORT[d.getDay()] : "";
}
function weekdayLong(dateStr) {
  const d = parseLocalDate(dateStr);
  return d ? WEEKDAY_LONG[d.getDay()] : "";
}
// "12 Nov" style label.
function shortDateLabel(dateStr) {
  const d = parseLocalDate(dateStr);
  return d ? `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}` : dateStr;
}
// "Friday, 21 Nov 2026" — the app's date format, shown wherever a
// native date input would otherwise render in the browser's locale
// (the finish dialog showed "11/21/2026" on a US-locale browser).
function longDateLabel(dateStr) {
  const d = parseLocalDate(dateStr);
  return d ? `${WEEKDAY_LONG[d.getDay()]}, ${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}` : dateStr;
}
function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function mealRank(meal) {
  return meal === "breakfast" ? 0 : meal === "lunch" ? 1 : 2;
}
function slotBefore(date, meal, date2, meal2) {
  return date < date2 || (date === date2 && mealRank(meal) < mealRank(meal2));
}
function lastCookedLabel(recipe) {
  return recipe.last_cooked ? `Last cooked ${shortDateLabel(recipe.last_cooked)}` : "Never cooked";
}
function resolutionLabel(resolution) {
  return resolution === "cooked" ? "Cooked"
    : resolution === "eat_out" ? "Did not cook"
    : resolution === "leftovers" ? "Leftovers"
    : resolution === "skipped" ? "Skipped" : "";
}

// --- API (same shape as the shell's api() in shell/public/app.js) ---
function getToken() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
async function api(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
      signal: controller.signal,
    });
  } catch (err) {
    const error = new Error(controller.signal.aborted ? "request timed out" : "request failed");
    error.timedOut = controller.signal.aborted;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// --- Widget: next unrecorded planned meal (spec §4) ---
export async function widget() {
  try {
    const { res, data } = await api(`/api/kitchen/next-meal?date=${localTodayStr()}`);
    if (!res.ok || !data.ok || !data.next) return null;
    const n = data.next;
    // No duration line: recipes no longer record a cook time (0.4.0).
    const body = `${cap(n.meal)} · ${n.recipe_name} — ${weekdayLong(n.date)}, ${shortDateLabel(n.date)}`;
    return { title: "Next meal", body, href: "/kitchen/today" };
  } catch {
    // No token, no localStorage, fetch failed — the widget hides.
    return null;
  }
}

// --- Mount ---
let mountSeq = 0;

const TABS = [
  ["today", "Today", "/kitchen/today"],
  ["plan", "Plan", "/kitchen/plan"],
  ["recipes", "Recipes", "/kitchen/recipes"],
  ["shop", "Shop", "/kitchen/shop"],
  ["pantry", "Pantry", "/kitchen/pantry"],
];

export function mount(el) {
  const gen = ++mountSeq;
  const path = window.location.pathname;
  let tab = "today";
  if (path === "/kitchen/plan") tab = "plan";
  else if (path === "/kitchen/recipes") tab = "recipes";
  else if (path === "/kitchen/shop") tab = "shop";
  else if (path === "/kitchen/pantry") tab = "pantry";

  const ctx = {
    el,
    tab,
    gen,
    notice: "",
    success: "",
    // Today
    todayData: null,
    planDays: [],
    planWeekStart: null,
    recipes: [],
    // Plan
    planView: "this", // "this" | "next"
    planWeek: mondayStrOf(localTodayStr()),
    planWarnings: [],
    // Recipes
    recipesView: { kind: "list" },
    allRecipes: [],
    members: null,
    // Shop
    shopView: "this", // "this" | "next"
    shopData: null,
    // Pantry
    pantryItems: [],
  };

  const tabsHTML = `<nav style="display:flex;gap:0.25rem;border-bottom:1px solid var(--border);margin-bottom:1rem;overflow-x:auto">`
    + TABS.map(([id, label, href]) => {
      const active = id === tab;
      const style = active
        ? "font-weight:700;color:var(--accent);border-bottom:2px solid var(--accent)"
        : "color:var(--ink-muted)";
      return `<a href="${href}" data-route="kitchen" style="padding:0.6rem 0.75rem;text-decoration:none;white-space:nowrap;${style}">${label}</a>`;
    }).join("")
    + `</nav>`;

  el.innerHTML = tabsHTML + `<div id="kitchen-content"></div>`;
  ctx.content = el.querySelector("#kitchen-content");

  const render = () => {
    if (tab === "today") return renderToday(ctx);
    if (tab === "plan") return renderPlan(ctx);
    if (tab === "recipes") return renderRecipes(ctx);
    if (tab === "shop") return renderShop(ctx);
    return renderPantry(ctx);
  };
  render().catch((err) => {
    if (gen !== mountSeq) return;
    console.warn("kitchen render failed", err);
    ctx.content.innerHTML = `<div class="empty-state"><h2>Couldn’t load Kitchen</h2>`
      + `<p>Something went wrong — check your connection and try again.</p>`
      + `<p><button class="btn btn-primary" type="button" id="kitchen-retry">Try again</button></p></div>`;
    const retry = ctx.content.querySelector("#kitchen-retry");
    if (retry) retry.addEventListener("click", () => { ctx.notice = ""; ctx.success = ""; void render(); });
  });
}

// --- Shared render helpers ---

function isCurrent(ctx) {
  return ctx.gen === mountSeq;
}
// Errors render red, successes green (0.4.0): copy-forward and
// finish-run confirmations used to render in the error colour.
function noticeHTML(ctx) {
  let html = "";
  if (ctx.notice) html += `<p class="error">${escapeHTML(ctx.notice)}</p>`;
  if (ctx.success) html += `<p class="success">${escapeHTML(ctx.success)}</p>`;
  return html;
}
function sessionEndedHTML() {
  return `<div class="empty-state"><h2>Your session ended</h2>`
    + `<p>Sign in again to continue.</p></div>`;
}
function loadingHTML(label) {
  return `<div class="empty-state"><p>Loading ${escapeHTML(label)}…</p></div>`;
}
function loadErrorHTML(ctx, label) {
  return `<div class="empty-state"><h2>Couldn’t load ${escapeHTML(label)}</h2>`
    + `<p>Check your connection and try again.</p>`
    + `<p><button class="btn btn-primary" type="button" data-kitchen-retry>Try again</button></p></div>`;
}
function wireRetry(ctx, rerender) {
  const btn = ctx.content.querySelector("[data-kitchen-retry]");
  if (btn) btn.addEventListener("click", () => { ctx.notice = ""; ctx.success = ""; void rerender(); });
}
// Busy state, the 0.1.8 pattern: disable + in-flight label, restored on failure.
function busy(btn, label) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  return () => {
    btn.disabled = false;
    btn.textContent = original;
  };
}
function friendlyError(data) {
  const map = {
    already_planned_this_week: "That recipe is already planned this week.",
    invalid_swap_target: "Pick another planned meal to swap with.",
    slot_resolved: "That meal is already recorded — clear it first.",
    no_planned_recipe: "There’s no planned recipe to change here.",
    leftover_slot_taken: "Tomorrow’s slot is already planned.",
    recipe_name_required: "Give the recipe a name first.",
    invalid_servings: "Servings must be a positive number.",
    recipe_not_found: "That recipe no longer exists.",
    invalid_leftover_source: "Pick an earlier planned recipe as the leftovers source.",
    no_active_run: "Generate a shopping list first.",
    active_run_exists: "Finish the current shopping run first.",
    invalid_week: "Pick this week or next week.",
    invalid_category: "Pick a category from the list.",
    invalid_state: "That list state isn’t valid.",
    invalid_quantity: "Quantity must be a positive number.",
    invalid_run_date: "Pick a run date that isn’t in the future.",
    invalid_price: "Prices must be 0 or more.",
    invalid_carry_over: "That carry-over choice isn’t valid.",
    invalid_on_hand: "Pick Have or Out.",
    item_required: "Give the item a name first.",
    item_not_found: "That item no longer exists.",
    line_not_found: "That list item no longer exists.",
    run_finished: "That shopping run is finished.",
    pantry_item_not_found: "That pantry item no longer exists.",
  };
  return (data && data.error && map[data.error]) || "Something went wrong — please try again.";
}

// --- TODAY ---

async function renderToday(ctx) {
  const todayStr = localTodayStr();
  const weekStart = mondayStrOf(todayStr);
  ctx.content.innerHTML = loadingHTML("today");
  let tRes, tData, pRes, pData, rRes, rData;
  try {
    [{ res: tRes, data: tData }, { res: pRes, data: pData }, { res: rRes, data: rData }] = await Promise.all([
      api(`/api/kitchen/today?date=${todayStr}`),
      api(`/api/kitchen/plan?week_start=${weekStart}`),
      api("/api/kitchen/recipes"),
    ]);
  } catch {
    if (!isCurrent(ctx)) return;
    ctx.content.innerHTML = loadErrorHTML(ctx, "today");
    wireRetry(ctx, () => renderToday(ctx));
    return;
  }
  if (!isCurrent(ctx)) return;
  if (tRes.status === 401 || pRes.status === 401 || rRes.status === 401) {
    ctx.content.innerHTML = sessionEndedHTML();
    return;
  }
  if (!tRes.ok || !tData.ok || !pRes.ok || !pData.ok || !rRes.ok || !rData.ok) {
    ctx.content.innerHTML = loadErrorHTML(ctx, "today");
    wireRetry(ctx, () => renderToday(ctx));
    return;
  }
  ctx.todayData = tData;
  ctx.planDays = pData.days || [];
  ctx.planWeekStart = weekStart;
  ctx.recipes = rData.recipes || [];

  const meals = tData.meals || [];
  let html = noticeHTML(ctx)
    + `<h2 class="section-head">Today — ${weekdayLong(todayStr)}, ${shortDateLabel(todayStr)}</h2>`;

  for (const meal of MEALS) {
    const m = meals.find((x) => x.meal === meal);
    html += `<h3 class="section-head">${cap(meal)}</h3>`;
    if (!m) {
      html += `<p class="muted">Nothing planned yet. <a href="/kitchen/plan" data-route="kitchen">Plan it</a></p>`;
      continue;
    }
    html += todayMealHTML(m);
  }

  const unresolved = tData.unresolved || [];
  if (unresolved.length > 0) {
    html += `<h2 class="section-head">Earlier this week — not recorded</h2><div class="list">`;
    for (const u of unresolved) {
      html += `<div class="list-row unresolved-row"><div>${escapeHTML(weekdayShort(u.date))} ${escapeHTML(shortDateLabel(u.date))} · ${escapeHTML(cap(u.meal))} — ${escapeHTML(u.recipe_name || "")}</div>`
        + `<div class="resolve-actions">${resolveButtonsHTML(u.week_start, u.date, u.meal)}</div>`
        + `</div>`;
    }
    html += `</div>`;
  }

  ctx.content.innerHTML = html;
  wireToday(ctx, todayStr, weekStart);
}

function todayMealHTML(m) {
  if (m.state === "eat_out") {
    return `<div class="list"><div class="list-row"><span style="flex:1">Eat out</span><span class="muted">Decided</span></div></div>`;
  }
  if (m.state === "leftovers") {
    const src = m.source_recipe_name
      ? `Leftovers from ${m.source_recipe_name}`
      : "Leftovers";
    return `<div class="list"><div class="list-row"><span style="flex:1">${escapeHTML(src)}</span><span class="muted">Decided</span></div></div>`;
  }
  // Recipe slot. When unresolved, the name block takes its own line and
  // the resolve pills sit in a wrapping row below it — the old layout
  // squeezed the pills beside the name and they overlapped the label at
  // phone width. Resolved slots keep the name + Clear side by side.
  const r = m.recipe;
  const name = escapeHTML(m.recipe_name || (r && r.name) || "");
  const nameStyle = m.resolution ? "flex:1;min-width:12rem" : "flex:1 1 100%;min-width:0";
  let html = `<div class="list"><div class="list-row" style="flex-wrap:wrap"><div style="${nameStyle}">`
    + `<strong>${name}</strong>`;
  // No cook time or "usually X" (0.4.0): those fields are gone.
  if (m.servings) html += `<br><span class="muted">${m.servings} servings</span>`;
  if (m.resolution) {
    html += `<br><span class="muted">${escapeHTML(resolutionLabel(m.resolution))}</span>`;
  }
  html += `</div>`;
  if (m.resolution) {
    html += `<button class="btn btn-ghost" type="button" data-resolve="null" data-week="${escapeHTML(m.week_start || "")}" data-date="${escapeHTML(m.date)}" data-meal="${escapeHTML(m.meal)}">Clear</button>`;
  } else {
    html += `<div class="resolve-actions" style="flex:1 1 100%">`
      + resolveButtonsHTML(m.week_start || "", m.date, m.meal)
      + `<button class="btn btn-ghost" type="button" data-cook-else="${escapeHTML(m.date)}" data-meal="${escapeHTML(m.meal)}">Cook something else</button></div>`;
  }
  html += `</div>`;
  // Cooking view: ingredients, then the instructions as written.
  if (r && ((r.ingredients && r.ingredients.length > 0) || r.instructions)) {
    html += `<details style="padding:0.5rem 1rem"><summary>Cooking view — ingredients &amp; instructions</summary>`;
    if (r.ingredients && r.ingredients.length > 0) {
      html += `<h3 class="section-head">Ingredients</h3><ul>`;
      for (const ing of r.ingredients) {
        const qty = [ing.quantity, ing.unit].filter((x) => x !== null && x !== undefined && x !== "").join(" ");
        html += `<li>${qty ? `${escapeHTML(String(qty))} ` : ""}${escapeHTML(cap(ing.name))}${ing.prep_note ? ` — ${escapeHTML(ing.prep_note)}` : ""}</li>`;
      }
      html += `</ul>`;
    }
    if (r.instructions) {
      html += `<h3 class="section-head">Instructions</h3><p style="white-space:pre-wrap">${escapeHTML(r.instructions)}</p>`;
    }
    html += `</details>`;
  }
  html += `</div>`;
  return html;
}

function resolveButtonsHTML(weekStart, date, meal) {
  const attrs = `data-week="${escapeHTML(weekStart)}" data-date="${escapeHTML(date)}" data-meal="${escapeHTML(meal)}"`;
  return `<button class="btn btn-primary" type="button" data-resolve="cooked" ${attrs}>Mark cooked</button>`
    + `<button class="btn btn-ghost" type="button" data-resolve="eat_out" ${attrs}>Did not cook</button>`
    + `<button class="btn btn-ghost" type="button" data-resolve="leftovers" ${attrs}>Leftovers</button>`
    + `<button class="btn btn-ghost" type="button" data-resolve="skipped" ${attrs}>Skipped</button>`;
}

function wireToday(ctx, todayStr, weekStart) {
  ctx.content.querySelectorAll("[data-resolve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const resolution = btn.getAttribute("data-resolve") === "null" ? null : btn.getAttribute("data-resolve");
      const week = btn.getAttribute("data-week") || weekStart;
      const date = btn.getAttribute("data-date");
      const meal = btn.getAttribute("data-meal");
      const restore = busy(btn, "Saving…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/plan/resolve", "POST", {
          week_start: week, date, meal, resolution,
        }));
      } catch {
        restore();
        ctx.success = ""; ctx.notice = "Couldn’t record that — check your connection and try again.";
        void renderToday(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderToday(ctx);
        return;
      }
      // Mark cooked: offer the leftovers shortcut for tomorrow's same meal.
      if (resolution === "cooked") {
        const slot = (ctx.todayData.meals || []).find((x) => x.date === date && x.meal === meal);
        // The slot's recipe_name can be empty (it comes from the plan
        // row, not the recipe); fall back to the recipe detail, then
        // the library, so the prompt never shows a blank name.
        const recipeName = (slot && (slot.recipe_name || (slot.recipe && slot.recipe.name))) || "";
        const fallback = !recipeName && slot && slot.recipe_id
          ? ((ctx.recipes || []).find((r) => r.id === slot.recipe_id) || {}).name || ""
          : "";
        await offerLeftoverTomorrow(ctx, week, date, meal, recipeName || fallback);
      }
      ctx.notice = ""; ctx.success = "";
      void renderToday(ctx);
    });
  });
  ctx.content.querySelectorAll("[data-cook-else]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = btn.getAttribute("data-cook-else");
      const meal = btn.getAttribute("data-meal");
      const slot = (ctx.todayData.meals || []).find((x) => x.date === date && x.meal === meal);
      if (slot) openCookSomethingElse(ctx, weekStart, slot);
    });
  });
}

// After a successful Mark cooked: if tomorrow's same-meal slot is
// unplanned, offer to set it to leftovers from this recipe.
async function offerLeftoverTomorrow(ctx, weekStart, dateStr, meal, recipeName) {
  const tomorrow = addDaysStr(dateStr, 1);
  if (!tomorrow) return;
  let days = ctx.planDays;
  if (mondayStrOf(tomorrow) !== weekStart) {
    // Tomorrow is next week — fetch that week's plan to check the slot.
    try {
      const { res, data } = await api(`/api/kitchen/plan?week_start=${mondayStrOf(tomorrow)}`);
      if (!res.ok || !data.ok) return;
      days = data.days || [];
    } catch {
      return;
    }
  }
  const taken = days.some((d) => d.date === tomorrow && d.meal === meal);
  if (taken) return;
  const yes = await confirmPrompt({
    title: "Leftovers tomorrow?",
    message: `Set tomorrow’s ${escapeHTML(meal)} to leftovers from ${escapeHTML(recipeName)}?`,
    confirmLabel: "Set leftovers",
  });
  if (!yes || !isCurrent(ctx)) return;
  try {
    await api("/api/kitchen/plan/resolve", "POST", {
      week_start: weekStart,
      date: dateStr,
      meal,
      resolution: "cooked",
      leftover_slot: { date: tomorrow, meal },
    });
  } catch {
    // The cooked record already landed; a failed shortcut is just lost.
  }
}

// "Cook something else" sheet: swap / library / new recipe.
function openCookSomethingElse(ctx, weekStart, slot) {
  const body = document.createElement("div");
  const currentLabel = `${weekdayLong(slot.date)}, ${shortDateLabel(slot.date)} ${slot.meal} — ${slot.recipe_name || ""}`;

  // Swap candidates: other planned, unrecorded recipe slots this week.
  const swapTargets = ctx.planDays.filter((d) =>
    d.state === "recipe" && d.recipe_id && !d.resolution
    && !(d.date === slot.date && d.meal === slot.meal));
  // Library candidates: recipes not already planned this week.
  const plannedIds = new Set(ctx.planDays.filter((d) => d.recipe_id).map((d) => d.recipe_id));
  const library = ctx.recipes.filter((r) => !plannedIds.has(r.id));

  let html = `<p class="muted">Currently: ${escapeHTML(currentLabel)}</p>`;

  html += `<h3 class="section-head">Swap with another planned slot</h3>`;
  if (swapTargets.length === 0) {
    html += `<p class="muted">No other planned meals this week to swap with.</p>`;
  } else {
    html += `<div class="list">` + swapTargets.map((d) =>
      `<div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(weekdayShort(d.date))} ${escapeHTML(shortDateLabel(d.date))} · ${escapeHTML(cap(d.meal))} — ${escapeHTML(d.recipe_name || "")}</span>`
      + `<button class="btn btn-ghost" type="button" data-swap-date="${escapeHTML(d.date)}" data-swap-meal="${escapeHTML(d.meal)}" data-swap-name="${escapeHTML(d.recipe_name || "")}">Swap</button></div>`
    ).join("") + `</div>`;
  }

  html += `<h3 class="section-head">Pick from library</h3>`;
  if (library.length === 0) {
    html += `<p class="muted">Every recipe is already planned this week.</p>`;
  } else {
    html += `<div class="list">` + library.map((r) =>
      `<div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(r.name)} <span class="muted">— ${escapeHTML(lastCookedLabel(r))}</span></span>`
      + `<button class="btn btn-ghost" type="button" data-library-id="${escapeHTML(r.id)}" data-library-name="${escapeHTML(r.name)}">Use this</button></div>`
    ).join("") + `</div>`;
  }

  html += `<h3 class="section-head">New recipe by name</h3>`
    + `<p><input class="field" id="cse-new-name" type="text" placeholder="Recipe name" autocomplete="off" maxlength="200"></p>`
    + `<p><button class="btn btn-primary" type="button" id="cse-new-go">Create and plan</button></p>`
    + `<p class="error" id="cse-error"></p>`;

  body.innerHTML = html;
  const close = openSheet({
    title: "Cook something else",
    body,
    actions: [{ label: "Close", kind: "ghost" }],
  });

  const fail = (message) => {
    const errEl = body.querySelector("#cse-error");
    if (errEl) errEl.textContent = message;
  };

  body.querySelectorAll("[data-swap-date]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetDate = btn.getAttribute("data-swap-date");
      const targetMeal = btn.getAttribute("data-swap-meal");
      const targetName = btn.getAttribute("data-swap-name");
      const yes = await confirmPrompt({
        title: "Swap meals?",
        message: `Swap ${escapeHTML(currentLabel)} with ${escapeHTML(weekdayLong(targetDate))}, ${escapeHTML(shortDateLabel(targetDate))} ${escapeHTML(targetMeal)} — ${escapeHTML(targetName)}?`,
        confirmLabel: "Swap",
      });
      if (!yes || !isCurrent(ctx)) return;
      const restore = busy(btn, "Saving…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/plan/cook-something-else", "POST", {
          week_start: weekStart, date: slot.date, meal: slot.meal,
          mode: "swap", target_date: targetDate, target_meal: targetMeal,
        }));
      } catch {
        restore();
        fail("Couldn’t swap — check your connection and try again.");
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        fail(friendlyError(data));
        return;
      }
      close();
      ctx.notice = ""; ctx.success = "";
      void renderToday(ctx);
    });
  });

  body.querySelectorAll("[data-library-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const recipeId = btn.getAttribute("data-library-id");
      const recipeName = btn.getAttribute("data-library-name");
      const yes = await confirmPrompt({
        title: "Change this meal?",
        message: `Replace ${escapeHTML(currentLabel)} with ${escapeHTML(recipeName)}?`,
        confirmLabel: "Replace",
      });
      if (!yes || !isCurrent(ctx)) return;
      const restore = busy(btn, "Saving…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/plan/cook-something-else", "POST", {
          week_start: weekStart, date: slot.date, meal: slot.meal,
          mode: "library", recipe_id: recipeId,
        }));
      } catch {
        restore();
        fail("Couldn’t change the meal — check your connection and try again.");
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        fail(friendlyError(data));
        return;
      }
      close();
      ctx.notice = ""; ctx.success = "";
      void renderToday(ctx);
    });
  });

  const newBtn = body.querySelector("#cse-new-go");
  if (newBtn) {
    newBtn.addEventListener("click", async () => {
      const name = body.querySelector("#cse-new-name").value.trim();
      if (!name) {
        fail("Give the new recipe a name first.");
        return;
      }
      const restore = busy(newBtn, "Creating…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/plan/cook-something-else", "POST", {
          week_start: weekStart, date: slot.date, meal: slot.meal,
          mode: "new", name,
        }));
      } catch {
        restore();
        fail("Couldn’t create the recipe — check your connection and try again.");
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        fail(friendlyError(data));
        return;
      }
      close();
      ctx.notice = data.duplicate_name_warning
        ? "A recipe with this name already exists."
        : "";
      void renderToday(ctx);
    });
  }
}

// --- PLAN ---

async function renderPlan(ctx) {
  const thisWeek = mondayStrOf(localTodayStr());
  const weekStart = ctx.planView === "next" ? addDaysStr(thisWeek, 7) : thisWeek;
  ctx.planWeek = weekStart;
  ctx.content.innerHTML = loadingHTML("plan");
  let pRes, pData, rRes, rData;
  try {
    [{ res: pRes, data: pData }, { res: rRes, data: rData }] = await Promise.all([
      api(`/api/kitchen/plan?week_start=${weekStart}`),
      api("/api/kitchen/recipes"),
    ]);
  } catch {
    if (!isCurrent(ctx)) return;
    ctx.content.innerHTML = loadErrorHTML(ctx, "plan");
    wireRetry(ctx, () => renderPlan(ctx));
    return;
  }
  if (!isCurrent(ctx)) return;
  if (pRes.status === 401 || rRes.status === 401) {
    ctx.content.innerHTML = sessionEndedHTML();
    return;
  }
  if (!pRes.ok || !pData.ok || !rRes.ok || !rData.ok) {
    ctx.content.innerHTML = loadErrorHTML(ctx, "plan");
    wireRetry(ctx, () => renderPlan(ctx));
    return;
  }
  ctx.planDays = pData.days || [];
  ctx.planWarnings = pData.warnings || [];
  ctx.recipes = rData.recipes || [];

  const weekEnd = addDaysStr(weekStart, 6);
  let html = noticeHTML(ctx)
    + `<h2 class="section-head">Week of ${shortDateLabel(weekStart)} – ${shortDateLabel(weekEnd)}</h2>`
    + `<div class="segmented"><button class="btn ${ctx.planView === "this" ? "btn-primary" : "btn-ghost"}" type="button" data-week-view="this">This week</button>`
    + `<button class="btn ${ctx.planView === "next" ? "btn-primary" : "btn-ghost"}" type="button" data-week-view="next">Next week</button></div>`;

  if (ctx.planWarnings.length > 0) {
    html += `<div class="list">` + ctx.planWarnings.map((w) =>
      `<div class="list-row"><span>⚠ <strong>${escapeHTML(w.recipe_name)}</strong> — ${escapeHTML(w.detail)}</span></div>`
    ).join("") + `</div>`;
  }

  // Day list (0.4.0): one row per day — day label, its planned meals
  // (or "Nothing planned yet"), and a Plan button for that day. Only
  // planned meals show; there is no seven-column grid of narrow cells
  // to aim at, and no always-open row of meal pills.
  html += `<div class="list">`;
  for (let i = 0; i < 7; i++) {
    const date = addDaysStr(weekStart, i);
    const days = ctx.planDays.filter((d) => d.date === date);
    html += `<div class="list-row plan-day-row"><div style="flex:1;min-width:0">`
      + `<strong>${escapeHTML(weekdayLong(date))}, ${escapeHTML(shortDateLabel(date))}</strong>`;
    if (days.length === 0) {
      html += `<br><span class="muted">Nothing planned yet</span>`;
    } else {
      for (const d of days) {
        const label = d.state === "recipe" ? (d.recipe_name || "")
          : d.state === "eat_out" ? "Eat out" : "Leftovers";
        html += `<br><button class="text-button plan-day-meal" type="button" data-day-meal="${escapeHTML(date)}" data-meal="${escapeHTML(d.meal)}">${escapeHTML(cap(d.meal))} — ${escapeHTML(label)}${d.servings ? ` · ${d.servings} servings` : ""}</button>`
          + (d.resolution ? `<br><span class="muted">${escapeHTML(resolutionLabel(d.resolution))}</span>` : "");
      }
    }
    html += `</div><button class="btn btn-ghost" type="button" data-plan-day="${escapeHTML(date)}">Plan</button></div>`;
  }
  html += `</div>`;

  if (ctx.planView === "this") {
    html += `<p><button class="btn btn-primary" type="button" id="copy-forward">Copy this week to next week</button></p>`;
  }

  ctx.content.innerHTML = html;
  wirePlan(ctx, weekStart);
}

// Meal chooser for one day: which meal to plan, showing what each
// already holds. Tapping a meal opens the slot picker for it.
function openDayPicker(ctx, weekStart, dateStr) {
  const body = document.createElement("div");
  let html = `<p class="muted">${escapeHTML(weekdayLong(dateStr))}, ${escapeHTML(shortDateLabel(dateStr))}</p><div class="list">`;
  for (const meal of MEALS) {
    const d = ctx.planDays.find((x) => x.date === dateStr && x.meal === meal);
    const state = !d ? "Not planned yet"
      : d.state === "recipe" ? (d.recipe_name || "")
      : d.state === "eat_out" ? "Eat out" : "Leftovers";
    html += `<div class="list-row"><span style="flex:1;min-width:0"><strong>${escapeHTML(cap(meal))}</strong>`
      + `<br><span class="muted">${escapeHTML(state)}${d && d.servings ? ` · ${d.servings} servings` : ""}</span></span>`
      + `<button class="btn btn-ghost" type="button" data-day-pick-meal="${escapeHTML(meal)}">${d ? "Change" : "Plan"}</button></div>`;
  }
  html += `</div>`;
  body.innerHTML = html;
  const close = openSheet({
    title: `Plan ${weekdayLong(dateStr)}`,
    body,
    actions: [{ label: "Close", kind: "ghost" }],
  });
  body.querySelectorAll("[data-day-pick-meal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const meal = btn.getAttribute("data-day-pick-meal");
      const existing = ctx.planDays.find((d) => d.date === dateStr && d.meal === meal);
      close();
      openSlotPicker(ctx, weekStart, dateStr, meal, existing || null);
    });
  });
}

function wirePlan(ctx, weekStart) {
  ctx.content.querySelectorAll("[data-week-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.planView = btn.getAttribute("data-week-view");
      ctx.notice = ""; ctx.success = "";
      void renderPlan(ctx);
    });
  });
  ctx.content.querySelectorAll("[data-plan-day]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openDayPicker(ctx, weekStart, btn.getAttribute("data-plan-day"));
    });
  });
  ctx.content.querySelectorAll("[data-day-meal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = btn.getAttribute("data-day-meal");
      const meal = btn.getAttribute("data-meal");
      const existing = ctx.planDays.find((d) => d.date === date && d.meal === meal);
      openSlotPicker(ctx, weekStart, date, meal, existing || null);
    });
  });
  const copyBtn = ctx.content.querySelector("#copy-forward");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const restore = busy(copyBtn, "Copying…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/plan/copy-forward", "POST", { from_week_start: weekStart }));
      } catch {
        restore();
        ctx.success = ""; ctx.notice = "Couldn’t copy the week — check your connection and try again.";
        void renderPlan(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderPlan(ctx);
        return;
      }
      ctx.success = `Copied ${data.copied} slot${data.copied === 1 ? "" : "s"}, skipped ${data.skipped} already planned.`;
      ctx.notice = "";
      void renderPlan(ctx);
    });
  }
}

// Slot picker sheet for one (date, meal) cell.
function openSlotPicker(ctx, weekStart, dateStr, meal, existing) {
  const body = document.createElement("div");
  // The "cooked last week" warning still comes from the server
  // (planWarnings, computed from the saved plan); the duplicate
  // warning is LIVE here (0.4.0) — counted from the plan as it
  // stands, so it shows before saving instead of only after.
  const recentWarnings = new Map(
    (ctx.planWarnings || []).filter((w) => w.type === "recent").map((w) => [w.recipe_id, w.detail]),
  );
  // "Not cooked in a while": never cooked, or last cooked 21+ days before this week.
  const staleCutoff = addDaysStr(weekStart, -21);
  const notAWhile = ctx.recipes.filter((r) => !r.last_cooked || r.last_cooked <= staleCutoff);
  const recent = ctx.recipes.filter((r) => r.last_cooked && r.last_cooked > staleCutoff);

  const recipeButton = (r) => {
    // Live duplicate count: other slots this week already holding
    // this recipe (the slot being edited doesn't count against
    // itself — re-planning the same recipe there is not a repeat).
    const dupCount = (ctx.planDays || []).filter(
      (d) => d.state === "recipe" && d.recipe_id === r.id && !(d.date === dateStr && d.meal === meal),
    ).length;
    const dup = dupCount === 0 ? ""
      : dupCount === 1 ? "⚠ Already planned once this week"
      : `⚠ Already planned ${dupCount} times this week`;
    const warn = recentWarnings.get(r.id);
    return `<div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(r.name)}`
      + `<br><span class="muted">${escapeHTML(lastCookedLabel(r))} · cooked ${r.times_cooked}×</span>`
      + (dup ? `<br><span class="error">${escapeHTML(dup)}</span>` : "")
      + (warn ? `<br><span class="error">⚠ ${escapeHTML(warn)}</span>` : "")
      + `</span><button class="btn btn-ghost" type="button" data-pick-recipe="${escapeHTML(r.id)}">Plan</button></div>`;
  };

  let html = `<p class="muted">${escapeHTML(weekdayLong(dateStr))}, ${escapeHTML(shortDateLabel(dateStr))} · ${escapeHTML(cap(meal))}</p>`;

  if (existing && existing.state === "recipe" && existing.recipe_id) {
    html += `<p>Currently: <strong>${escapeHTML(existing.recipe_name || "")}</strong>${existing.servings ? ` — ${existing.servings} servings` : ""}${existing.resolution ? ` (${escapeHTML(resolutionLabel(existing.resolution))})` : ""}</p>`
      + `<p><label class="muted">Servings</label><br><input class="field" id="slot-servings" type="number" min="1" max="100" inputmode="numeric" style="width:6rem" value="${existing.servings ?? ""}"></p>`
      + `<p><button class="btn btn-primary" type="button" id="slot-save-servings">Save servings</button></p>`;
  }

  if (notAWhile.length > 0) {
    html += `<h3 class="section-head">Not cooked in a while</h3><div class="list">`
      + notAWhile.map(recipeButton).join("") + `</div>`;
  }
  if (recent.length > 0) {
    html += `<h3 class="section-head">Recently cooked</h3><div class="list">`
      + recent.map(recipeButton).join("") + `</div>`;
  }
  if (ctx.recipes.length === 0) {
    html += `<p class="muted">No recipes yet — add one from the Recipes tab first.</p>`;
  }

  html += `<h3 class="section-head">Or</h3><p>`
    + `<button class="btn btn-ghost" type="button" id="slot-eat-out">Eat out</button> `
    + `<button class="btn btn-ghost" type="button" id="slot-leftovers">Leftovers</button>`
    + (existing ? ` <button class="btn btn-ghost" type="button" id="slot-clear">Clear</button>` : "")
    + `</p><div id="slot-leftover-sources"></div><p class="error" id="slot-error"></p>`;

  body.innerHTML = html;
  const close = openSheet({
    title: existing ? "Change this meal" : "Plan this meal",
    body,
    actions: [{ label: "Close", kind: "ghost" }],
  });

  const fail = (message) => {
    const errEl = body.querySelector("#slot-error");
    if (errEl) errEl.textContent = message;
  };

  const setSlot = async (btn, payload) => {
    const restore = busy(btn, "Saving…");
    let res, data;
    try {
      ({ res, data } = await api("/api/kitchen/plan/slot", "POST", { week_start: weekStart, date: dateStr, meal, ...payload }));
    } catch {
      restore();
      fail("Couldn’t save — check your connection and try again.");
      return false;
    }
    if (!res.ok || !data.ok) {
      restore();
      fail(friendlyError(data));
      return false;
    }
    close();
    ctx.notice = ""; ctx.success = "";
    void renderPlan(ctx);
    return true;
  };

  body.querySelectorAll("[data-pick-recipe]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const recipe = ctx.recipes.find((r) => r.id === btn.getAttribute("data-pick-recipe"));
      if (!recipe) return;
      await setSlot(btn, {
        state: "recipe",
        recipe_id: recipe.id,
        servings: existing && existing.servings ? existing.servings : (recipe.servings ?? null),
      });
    });
  });

  const servingsBtn = body.querySelector("#slot-save-servings");
  if (servingsBtn && existing && existing.recipe_id) {
    servingsBtn.addEventListener("click", async () => {
      const raw = body.querySelector("#slot-servings").value.trim();
      const servings = raw === "" ? null : Number(raw);
      if (servings !== null && (!Number.isFinite(servings) || servings <= 0)) {
        fail("Servings must be a positive number.");
        return;
      }
      await setSlot(servingsBtn, { state: "recipe", recipe_id: existing.recipe_id, servings });
    });
  }

  const eatOutBtn = body.querySelector("#slot-eat-out");
  if (eatOutBtn) {
    eatOutBtn.addEventListener("click", async () => {
      await setSlot(eatOutBtn, { state: "eat_out" });
    });
  }

  const leftoversBtn = body.querySelector("#slot-leftovers");
  if (leftoversBtn) {
    leftoversBtn.addEventListener("click", () => {
      // Source: earlier recipe slots from this week.
      const sources = ctx.planDays.filter((d) =>
        d.state === "recipe" && d.recipe_id && slotBefore(d.date, d.meal, dateStr, meal));
      const host = body.querySelector("#slot-leftover-sources");
      if (!host) return;
      if (sources.length === 0) {
        host.innerHTML = `<p class="muted">No earlier planned recipe this week to take leftovers from.</p>`;
        return;
      }
      host.innerHTML = `<h3 class="section-head">Leftovers from</h3><div class="list">`
        + sources.map((d) =>
          `<div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(weekdayShort(d.date))} ${escapeHTML(shortDateLabel(d.date))} · ${escapeHTML(cap(d.meal))} — ${escapeHTML(d.recipe_name || "")}</span>`
          + `<button class="btn btn-ghost" type="button" data-leftover-date="${escapeHTML(d.date)}" data-leftover-meal="${escapeHTML(d.meal)}">Use</button></div>`
        ).join("") + `</div>`;
      host.querySelectorAll("[data-leftover-date]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await setSlot(btn, {
            state: "leftovers",
            source_date: btn.getAttribute("data-leftover-date"),
            source_meal: btn.getAttribute("data-leftover-meal"),
          });
        });
      });
    });
  }

  const clearBtn = body.querySelector("#slot-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      const restore = busy(clearBtn, "Clearing…");
      let res, data;
      try {
        ({ res, data } = await api(`/api/kitchen/plan/slot?week_start=${weekStart}&date=${dateStr}&meal=${meal}`, "DELETE"));
      } catch {
        restore();
        fail("Couldn’t clear — check your connection and try again.");
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        fail(friendlyError(data));
        return;
      }
      close();
      ctx.notice = ""; ctx.success = "";
      void renderPlan(ctx);
    });
  }
}

// --- RECIPES ---

async function renderRecipes(ctx) {
  if (ctx.recipesView.kind === "detail") return renderRecipeDetail(ctx);
  if (ctx.recipesView.kind === "form") return renderRecipeForm(ctx);

  ctx.content.innerHTML = loadingHTML("recipes");
  let res, data;
  try {
    ({ res, data } = await api("/api/kitchen/recipes?include_archived=1"));
  } catch {
    if (!isCurrent(ctx)) return;
    ctx.content.innerHTML = loadErrorHTML(ctx, "recipes");
    wireRetry(ctx, () => renderRecipes(ctx));
    return;
  }
  if (!isCurrent(ctx)) return;
  if (res.status === 401) {
    ctx.content.innerHTML = sessionEndedHTML();
    return;
  }
  if (!res.ok || !data.ok) {
    ctx.content.innerHTML = loadErrorHTML(ctx, "recipes");
    wireRetry(ctx, () => renderRecipes(ctx));
    return;
  }
  ctx.allRecipes = data.recipes || [];
  const active = ctx.allRecipes.filter((r) => !r.archived_at);
  const archived = ctx.allRecipes.filter((r) => r.archived_at);

  let html = noticeHTML(ctx)
    + `<h2 class="section-head">Recipes</h2>`
    + `<p><button class="btn btn-primary" type="button" id="new-recipe">New recipe</button></p>`;
  if (active.length === 0) {
    html += `<div class="empty-state"><h2>No recipes yet</h2><p>Add your first one — a name alone is enough to start.</p></div>`;
  } else {
    html += `<div class="list">` + active.map((r) =>
      `<div class="list-row" data-recipe-row="${escapeHTML(r.id)}" style="cursor:pointer"><span style="flex:1;min-width:0"><strong>${escapeHTML(r.name)}</strong>`
      + `<br><span class="muted">${escapeHTML(lastCookedLabel(r))}`
      + (r.times_cooked > 0 ? ` · cooked ${r.times_cooked}×` : "")
      + (r.servings ? ` · ${r.servings} servings` : "")
      + ` · ${r.ingredient_count || 0} ingredient${(r.ingredient_count || 0) === 1 ? "" : "s"}</span></span></div>`
    ).join("") + `</div>`;
  }
  if (archived.length > 0) {
    html += `<h2 class="section-head">Archived</h2><div class="list">` + archived.map((r) =>
      `<div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(r.name)} <span class="muted">— ${escapeHTML(lastCookedLabel(r))}</span></span>`
      + `<button class="btn btn-ghost" type="button" data-restore-recipe="${escapeHTML(r.id)}">Restore</button></div>`
    ).join("") + `</div>`;
  }
  ctx.content.innerHTML = html;

  const newBtn = ctx.content.querySelector("#new-recipe");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      ctx.recipesView = { kind: "form", id: null };
      ctx.notice = ""; ctx.success = "";
      void renderRecipes(ctx);
    });
  }
  ctx.content.querySelectorAll("[data-recipe-row]").forEach((row) => {
    row.addEventListener("click", () => {
      ctx.recipesView = { kind: "detail", id: row.getAttribute("data-recipe-row") };
      ctx.notice = ""; ctx.success = "";
      void renderRecipes(ctx);
    });
  });
  ctx.content.querySelectorAll("[data-restore-recipe]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const restore = busy(btn, "Restoring…");
      let res, data;
      try {
        ({ res, data } = await api(`/api/kitchen/recipes/restore?id=${btn.getAttribute("data-restore-recipe")}`, "POST"));
      } catch {
        restore();
        ctx.success = ""; ctx.notice = "Couldn’t restore — check your connection and try again.";
        void renderRecipes(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderRecipes(ctx);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderRecipes(ctx);
    });
  });
}

async function renderRecipeDetail(ctx) {
  const id = ctx.recipesView.id;
  ctx.content.innerHTML = loadingHTML("recipe");
  let res, data;
  try {
    ({ res, data } = await api(`/api/kitchen/recipes?id=${encodeURIComponent(id)}`));
  } catch {
    if (!isCurrent(ctx)) return;
    ctx.content.innerHTML = loadErrorHTML(ctx, "recipe");
    wireRetry(ctx, () => renderRecipes(ctx));
    return;
  }
  if (!isCurrent(ctx)) return;
  if (res.status === 401) {
    ctx.content.innerHTML = sessionEndedHTML();
    return;
  }
  if (!res.ok || !data.ok) {
    ctx.content.innerHTML = loadErrorHTML(ctx, "recipe");
    wireRetry(ctx, () => renderRecipes(ctx));
    return;
  }
  const r = data.recipe;
  let html = noticeHTML(ctx)
    + `<p><button class="btn btn-ghost" type="button" id="back-to-recipes">← All recipes</button></p>`
    + `<h2 class="section-head">${escapeHTML(r.name)}</h2>`
    + `<p class="muted">${escapeHTML(lastCookedLabel(r))}`
    + (r.times_cooked > 0 ? ` · cooked ${r.times_cooked}×` : "")
    + (r.servings ? ` · serves ${r.servings}` : "")
    + `</p>`;
  if (r.ingredients && r.ingredients.length > 0) {
    html += `<h3 class="section-head">Ingredients</h3><ul>`;
    for (const ing of r.ingredients) {
      const qty = [ing.quantity, ing.unit].filter((x) => x !== null && x !== undefined && x !== "").join(" ");
      html += `<li>${qty ? `${escapeHTML(String(qty))} ` : ""}${escapeHTML(cap(ing.name))}${ing.prep_note ? ` — ${escapeHTML(ing.prep_note)}` : ""}</li>`;
    }
    html += `</ul>`;
  }
  // Simplified Recipe (0.4.0): one free-text instructions field,
  // shown as written — no steps, no notes, no usual cook, no cook time.
  if (r.instructions) {
    html += `<h3 class="section-head">Instructions</h3><p style="white-space:pre-wrap">${escapeHTML(r.instructions)}</p>`;
  }
  if ((!r.ingredients || r.ingredients.length === 0) && !r.instructions) {
    html += `<p class="muted">No ingredients or instructions yet — edit to add them.</p>`;
  }
  html += `<p><button class="btn btn-primary" type="button" id="edit-recipe">Edit</button> `
    + `<button class="btn btn-ghost" type="button" id="archive-recipe">Archive</button></p>`;
  ctx.content.innerHTML = html;

  ctx.content.querySelector("#back-to-recipes").addEventListener("click", () => {
    ctx.recipesView = { kind: "list" };
    ctx.notice = ""; ctx.success = "";
    void renderRecipes(ctx);
  });
  ctx.content.querySelector("#edit-recipe").addEventListener("click", () => {
    ctx.recipesView = { kind: "form", id };
    ctx.notice = ""; ctx.success = "";
    void renderRecipes(ctx);
  });
  ctx.content.querySelector("#archive-recipe").addEventListener("click", async () => {
    const yes = await confirmPrompt({
      title: "Archive this recipe?",
      message: `Archive ${escapeHTML(r.name)}? It leaves the picker but keeps its cooking history. You can restore it later.`,
      confirmLabel: "Archive",
    });
    if (!yes || !isCurrent(ctx)) return;
    let aRes, aData;
    try {
      ({ res: aRes, data: aData } = await api(`/api/kitchen/recipes?id=${encodeURIComponent(id)}`, "DELETE"));
    } catch {
      ctx.success = ""; ctx.notice = "Couldn’t archive — check your connection and try again.";
      void renderRecipes(ctx);
      return;
    }
    if (!aRes.ok || !aData.ok) {
      ctx.success = ""; ctx.notice = friendlyError(aData);
      void renderRecipes(ctx);
      return;
    }
    ctx.recipesView = { kind: "list" };
    ctx.notice = ""; ctx.success = "";
    void renderRecipes(ctx);
  });
}

function ingredientRowHTML(ing) {
  const i = ing || {};
  // Three lines: name + Remove on top, qty / unit / prep note below,
  // category on its own line — the 0.3.1 polish made rows two lines
  // because a wrapped row squeezed the name field and let Remove land
  // wherever the wrap fell; the category select gets the same treatment.
  // The name displays capitalised (cap) to match the detail view; the
  // value sent on save is canonicalised server-side (lowercased), so
  // the stored canonical name never changes.
  return `<div class="list-row rf-ing-row">`
    + `<div class="rf-line"><input class="field ing-name" type="text" placeholder="Ingredient" autocomplete="off" value="${escapeHTML(cap(i.name || ""))}">`
    + `<button class="btn btn-ghost rf-remove" type="button">Remove</button></div>`
    + `<div class="rf-line"><input class="field ing-qty" type="number" min="0" step="any" inputmode="decimal" placeholder="Qty" value="${i.quantity ?? ""}">`
    + `<input class="field ing-unit" type="text" placeholder="Unit" autocomplete="off" value="${escapeHTML(i.unit || "")}">`
    + `<input class="field ing-prep" type="text" placeholder="Prep note" autocomplete="off" value="${escapeHTML(i.prep_note || "")}"></div>`
    + `<div class="rf-line ing-category-line"><select class="field ing-category" aria-label="Category"><option value="">No category</option>`
    + SHOP_CATEGORIES.map((c) => `<option value="${escapeHTML(c)}"${i.category === c ? " selected" : ""}>${escapeHTML(c)}</option>`).join("")
    + `</select></div></div>`;
}
async function renderRecipeForm(ctx) {
  const editingId = ctx.recipesView.id;
  ctx.content.innerHTML = loadingHTML("recipe form");
  let recipe = null;
  if (editingId) {
    try {
      const { res, data } = await api(`/api/kitchen/recipes?id=${encodeURIComponent(editingId)}`);
      if (!isCurrent(ctx)) return;
      if (res.status === 401) {
        ctx.content.innerHTML = sessionEndedHTML();
        return;
      }
      if (!res.ok || !data.ok) {
        ctx.content.innerHTML = loadErrorHTML(ctx, "recipe");
        wireRetry(ctx, () => renderRecipes(ctx));
        return;
      }
      recipe = data.recipe;
    } catch {
      if (!isCurrent(ctx)) return;
      ctx.content.innerHTML = loadErrorHTML(ctx, "recipe");
      wireRetry(ctx, () => renderRecipes(ctx));
      return;
    }
  }
  if (!isCurrent(ctx)) return;

  const r = recipe || {};
  // Simplified Recipe (0.4.0): name + optional servings + ingredients
  // + one free-text instructions field. No usual cook, cook time,
  // notes, or steps — and no pre-rendered empty ingredient row: the
  // list starts empty with only "Add ingredient" visible.
  const ingredients = r.ingredients || [];

  let html = noticeHTML(ctx)
    + `<div class="recipe-form"><h2 class="section-head">${editingId ? "Edit recipe" : "New recipe"}</h2>`
    + `<p class="error" id="rf-error"></p>`
    + `<p><label class="muted">Name</label><br><input class="field" id="rf-name" type="text" autocomplete="off" maxlength="200" value="${escapeHTML(r.name || "")}"></p>`
    + `<p><label class="muted">Servings (optional)</label><br><input class="field" id="rf-servings" type="number" min="1" max="100" inputmode="numeric" style="width:8rem" value="${r.servings ?? ""}"></p>`
    + `<h3 class="section-head">Ingredients</h3><div id="rf-ingredients" class="list">`
    + ingredients.map(ingredientRowHTML).join("") + `</div>`
    + `<p><button class="btn btn-ghost" type="button" id="rf-add-ing">Add ingredient</button></p>`
    + `<h3 class="section-head">Instructions</h3>`
    + `<p><textarea class="field" id="rf-instructions" rows="6" placeholder="How to cook it — written however you like.">${escapeHTML(r.instructions || "")}</textarea></p>`
    + `<p><button class="btn btn-primary" type="button" id="rf-save">${editingId ? "Save changes" : "Create recipe"}</button> `
    + `<button class="btn btn-ghost" type="button" id="rf-cancel">Cancel</button></p></div>`;
  ctx.content.innerHTML = html;

  // Row editors: delegated clicks handle rows added later too.
  const ingHost = ctx.content.querySelector("#rf-ingredients");
  ingHost.addEventListener("click", (event) => {
    if (event.target.classList.contains("rf-remove")) {
      event.target.closest(".rf-ing-row").remove();
    }
  });
  ctx.content.querySelector("#rf-add-ing").addEventListener("click", () => {
    ingHost.insertAdjacentHTML("beforeend", ingredientRowHTML({}));
  });
  ctx.content.querySelector("#rf-cancel").addEventListener("click", () => {
    ctx.recipesView = editingId ? { kind: "detail", id: editingId } : { kind: "list" };
    ctx.notice = ""; ctx.success = "";
    void renderRecipes(ctx);
  });

  ctx.content.querySelector("#rf-save").addEventListener("click", async (event) => {
    const btn = event.currentTarget;
    const errEl = ctx.content.querySelector("#rf-error");
    const name = ctx.content.querySelector("#rf-name").value.trim();
    if (!name) {
      errEl.textContent = "Give the recipe a name first.";
      return;
    }
    const numOrNull = (value, max) => {
      if (value === "") return null;
      const n = Number(value);
      return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
    };
    const servings = numOrNull(ctx.content.querySelector("#rf-servings").value.trim(), 100);
    if (servings === undefined) {
      errEl.textContent = "Servings must be a positive number.";
      return;
    }
    const ingredients = [...ingHost.querySelectorAll(".rf-ing-row")].map((row) => {
      const qtyRaw = row.querySelector(".ing-qty").value.trim();
      const qty = qtyRaw === "" ? null : Number(qtyRaw);
      return {
        name: row.querySelector(".ing-name").value.trim(),
        quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
        unit: row.querySelector(".ing-unit").value.trim() || null,
        prep_note: row.querySelector(".ing-prep").value.trim() || null,
        category: row.querySelector(".ing-category").value || null,
      };
    }).filter((ing) => ing.name.length > 0);
    const payload = {
      name,
      servings,
      instructions: ctx.content.querySelector("#rf-instructions").value.trim(),
      ingredients,
    };
    const restore = busy(btn, editingId ? "Saving…" : "Creating…");
    let res, data;
    try {
      if (editingId) {
        ({ res, data } = await api(`/api/kitchen/recipes?id=${encodeURIComponent(editingId)}`, "PATCH", payload));
      } else {
        ({ res, data } = await api("/api/kitchen/recipes", "POST", payload));
      }
    } catch {
      restore();
      errEl.textContent = "Couldn’t save — check your connection and try again.";
      return;
    }
    if (!res.ok || !data.ok) {
      restore();
      errEl.textContent = friendlyError(data);
      return;
    }
    ctx.notice = data.duplicate_name_warning ? "A recipe with this name already exists." : "";
    ctx.recipesView = { kind: "detail", id: data.recipe.id };
    void renderRecipes(ctx);
  });
}

// --- SHOP / PANTRY (Batch 4) ---

const SHOP_CATEGORIES = ["Produce", "Meat and seafood", "Dairy and chilled", "Pantry and dry"];

function shopGroupFor(line) {
  return SHOP_CATEGORIES.includes(line.category) ? line.category : "Other";
}
function qtyLabel(line) {
  const parts = [];
  if (line.quantity !== null && line.quantity !== undefined) parts.push(String(line.quantity));
  if (line.unit) parts.push(line.unit);
  return parts.join(" ");
}
function daysAgoLabel(dateStr) {
  const d = parseLocalDate(dateStr);
  const today = parseLocalDate(localTodayStr());
  if (!d || !today) return "";
  const diff = Math.round((today - d) / 86400000);
  if (diff <= 0) return diff === 0 ? "today" : "in the future";
  return diff === 1 ? "yesterday" : `${diff} days ago`;
}
function lastBoughtLabel(line) {
  if (!line.last_bought_date) return "";
  let s = `Last bought ${daysAgoLabel(line.last_bought_date)}`;
  if (line.last_unit_price !== null && line.last_unit_price !== undefined) {
    s += ` · $${Number(line.last_unit_price).toFixed(2)}`;
  }
  return s;
}
function lineSourcesLabel(line) {
  if (line.source === "pantry_out") return "Pantry";
  if (line.source === "manual") return "Added manually";
  if (line.source === "carry_over") return "Carried over";
  const srcs = line.sources || [];
  if (srcs.length === 0) return "";
  return srcs.map((s) => `${s.name} — ${weekdayShort(s.date)} ${s.meal}`).join(", ");
}

// Canonical-item suggestions for the manual-add / pantry-add name
// fields: type at least 2 characters, pick a match to fill the name
// (and the category when the item has one). Picking remembers the
// item id; editing the name afterwards drops it (the caller checks
// the name still matches before sending item_id).
function wireItemSuggest(ctx, inputEl, suggestEl, onPick) {
  let seq = 0;
  inputEl.addEventListener("input", async () => {
    const q = inputEl.value.trim();
    const mySeq = ++seq;
    if (q.length < 2) {
      suggestEl.innerHTML = "";
      return;
    }
    let res, data;
    try {
      ({ res, data } = await api(`/api/kitchen/shop/items?q=${encodeURIComponent(q)}&limit=8`));
    } catch {
      return;
    }
    if (mySeq !== seq || !isCurrent(ctx)) return;
    if (!res.ok || !data.ok || !data.items || data.items.length === 0) {
      suggestEl.innerHTML = "";
      return;
    }
    suggestEl.innerHTML = data.items.map((it) =>
      `<div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(it.name)}`
      + (it.category ? ` <span class="muted">— ${escapeHTML(it.category)}</span>` : "")
      + `</span><button class="btn btn-ghost" type="button" data-suggest-id="${escapeHTML(it.id)}" data-suggest-name="${escapeHTML(it.name)}" data-suggest-category="${escapeHTML(it.category || "")}">Use</button></div>`
    ).join("");
    suggestEl.querySelectorAll("[data-suggest-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        onPick({
          id: btn.getAttribute("data-suggest-id"),
          name: btn.getAttribute("data-suggest-name"),
          category: btn.getAttribute("data-suggest-category") || null,
        });
        suggestEl.innerHTML = "";
      });
    });
  });
}

function shopLineHTML(l, finished) {
  const qty = qtyLabel(l);
  const meta = [];
  const src = lineSourcesLabel(l);
  if (src) meta.push(src);
  if (l.is_rounded && l.unrounded_quantity !== null && l.unrounded_quantity !== undefined) {
    meta.push(`rounded up from ${l.unrounded_quantity}`);
  }
  const lb = lastBoughtLabel(l);
  if (lb) meta.push(lb);
  // On a finished list a carried-over line is labelled as such (0.4.0):
  // it used to sit there with no buttons and no explanation.
  if (finished && l.carry_over) meta.push("Carried over to the next list");
  let html = `<div class="list-row" style="flex-wrap:wrap"><div style="flex:1;min-width:10rem">`
    + `<strong>${escapeHTML(l.display_name)}</strong>${qty ? ` — ${escapeHTML(qty)}` : ""}`;
  if (meta.length > 0) html += `<br><span class="muted">${meta.map(escapeHTML).join(" · ")}</span>`;
  html += `</div>`;
  if (!finished) {
    // Check off is the primary action; Uncheck is a ghost; Edit and
    // Remove are demoted to small text buttons (0.4.0) — the old
    // three-pill row wrapped Remove onto its own line.
    html += `<div class="shop-line-actions">`;
    html += l.state === "checked"
      ? `<button class="btn btn-ghost" type="button" data-shop-toggle="${escapeHTML(l.id)}" data-shop-state="checked">Uncheck</button>`
      : `<button class="btn btn-primary" type="button" data-shop-toggle="${escapeHTML(l.id)}" data-shop-state="to_buy">Check off</button>`;
    html += `<button class="text-button" type="button" data-shop-edit="${escapeHTML(l.id)}">Edit</button>`;
    html += `<button class="text-button" type="button" data-shop-remove="${escapeHTML(l.id)}" data-shop-name="${escapeHTML(l.display_name)}">Remove</button>`;
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

async function renderShop(ctx) {
  const thisWeek = mondayStrOf(localTodayStr());
  const weekStart = ctx.shopView === "next" ? addDaysStr(thisWeek, 7) : thisWeek;
  ctx.content.innerHTML = loadingHTML("shopping list");
  let res, data;
  try {
    ({ res, data } = await api(`/api/kitchen/shop?week_start=${weekStart}`));
  } catch {
    if (!isCurrent(ctx)) return;
    ctx.content.innerHTML = loadErrorHTML(ctx, "shopping list");
    wireRetry(ctx, () => renderShop(ctx));
    return;
  }
  if (!isCurrent(ctx)) return;
  if (res.status === 401) {
    ctx.content.innerHTML = sessionEndedHTML();
    return;
  }
  if (!res.ok || !data.ok) {
    ctx.content.innerHTML = loadErrorHTML(ctx, "shopping list");
    wireRetry(ctx, () => renderShop(ctx));
    return;
  }
  ctx.shopData = data;
  const run = data.run;
  const weekEnd = addDaysStr(weekStart, 6);
  const activeOtherWeek = data.active_run_week_start && data.active_run_week_start !== weekStart;

  let html = noticeHTML(ctx)
    + `<h2 class="section-head">Shop — week of ${shortDateLabel(weekStart)} – ${shortDateLabel(weekEnd)}</h2>`
    + `<div class="segmented"><button class="btn ${ctx.shopView === "this" ? "btn-primary" : "btn-ghost"}" type="button" data-shop-view="this">This week</button>`
    + `<button class="btn ${ctx.shopView === "next" ? "btn-primary" : "btn-ghost"}" type="button" data-shop-view="next">Next week</button></div>`;

  if (!run) {
    if (activeOtherWeek) {
      const otherView = data.active_run_week_start === thisWeek ? "this" : "next";
      html += `<div class="empty-state"><h2>Your active list is for the week of ${shortDateLabel(data.active_run_week_start)}</h2>`
        + `<p>Finish that run first — one active list at a time.</p>`
        + `<p><button class="btn btn-primary" type="button" data-shop-view="${otherView}">View that list</button></p></div>`;
    } else {
      html += `<div class="empty-state"><h2>No shopping list yet</h2>`
        + `<p>Generate one from this week’s plan — quantities scale to the planned servings.</p>`
        + `<p><button class="btn btn-primary" type="button" id="shop-generate">Generate shopping list</button></p></div>`;
    }
    ctx.content.innerHTML = html;
    wireShop(ctx, weekStart);
    return;
  }

  const finished = run.status === "finished";
  const statusLabel = run.status === "draft" ? "Draft" : run.status === "shopping" ? "Shopping" : "Finished";
  html += `<p class="muted">Status: ${statusLabel}`
    + (run.run_date ? ` · shopped ${shortDateLabel(run.run_date)}` : "")
    + (run.store ? ` · ${escapeHTML(run.store)}` : "") + `</p>`;

  if (data.plan_changed) {
    html += `<div class="list"><div class="list-row"><span style="flex:1;min-width:0">The plan changed after this list was made.</span>`
      + `<button class="btn btn-primary" type="button" id="shop-regenerate">Regenerate</button></div></div>`;
  }

  const lines = data.lines || [];
  const groups = data.groups || [];
  const toBuy = lines.filter((l) => l.state === "to_buy");
  const checked = lines.filter((l) => l.state === "checked");
  if (lines.length === 0 && groups.length === 0) {
    html += `<p class="muted">Nothing on the list yet.</p>`;
  }
  // Meal groups (0.4.0), in week order: one combined line per item,
  // living in its earliest contributing group and naming the meals it
  // covers (the provenance line under each item). Every planned meal
  // gets its section, even when it has no lines of its own: a meal
  // whose items were all combined into an earlier group's lines says
  // so — otherwise the meal would vanish from the list — and a meal
  // whose lines are all checked off points at In trolley.
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupLabel = (g) => `${g.recipe_name || "Planned meal"} · ${weekdayShort(g.date)} ${g.meal}`;
  for (const g of groups) {
    const gLines = toBuy.filter((l) => l.group_id === g.id);
    const gChecked = checked.filter((l) => l.group_id === g.id);
    const stale = g.stale && !finished && !g.orphaned;
    html += `<h3 class="section-head">${escapeHTML(groupLabel(g))}</h3>`;
    if (stale) {
      html += `<div class="list"><div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(g.recipe_name || "This recipe")} changed since this list was made.</span>`
        + `<button class="btn btn-primary" type="button" data-shop-regenerate-group="${escapeHTML(g.id)}" data-group-date="${escapeHTML(g.date)}" data-group-meal="${escapeHTML(g.meal)}">Regenerate</button></div></div>`;
    }
    if (g.orphaned) {
      html += `<p class="muted">This meal is no longer planned — regenerate the list to remove it.</p>`;
    } else if (!g.has_ingredients) {
      html += `<p class="muted">No ingredients recorded — add items manually if needed.</p>`;
    } else if (gLines.length === 0) {
      // No lines of its own: either everything is checked off, or
      // its items were combined into an earlier group's lines (the
      // covers on those lines name this group — follow them to the
      // owning group).
      const ownerId = [...toBuy, ...checked]
        .filter((l) => (l.covers || []).includes(g.id))
        .map((l) => l.group_id)
        .find((id) => id && id !== g.id);
      const owner = ownerId ? groupById.get(ownerId) : null;
      if (gChecked.length > 0) {
        html += `<p class="muted">All checked off — see In trolley below.</p>`;
      } else if (owner) {
        html += `<p class="muted">Items combined under ${escapeHTML(groupLabel(owner))}.</p>`;
      }
    }
    if (gLines.length > 0) {
      html += `<div class="list">`;
      for (const l of gLines) html += shopLineHTML(l, finished);
      html += `</div>`;
    }
  }
  // Free items: manual adds, pantry-out lines, carry-overs — anything
  // with no group. Within a group lines stay ordered by category
  // (the server orders by category rank); free items the same.
  const free = toBuy.filter((l) => !l.group_id);
  if (free.length > 0) {
    html += `<h3 class="section-head">Free items</h3><div class="list">`;
    for (const l of free) html += shopLineHTML(l, finished);
    html += `</div>`;
  }
  if (checked.length > 0) {
    html += `<details><summary>In trolley (${checked.length})</summary><div class="list">`;
    for (const l of checked) html += shopLineHTML(l, finished);
    html += `</div></details>`;
  }

  if (!finished) {
    html += `<h3 class="section-head">Add an item</h3>`
      + `<p><input class="field" id="shop-add-name" type="text" placeholder="Item name" autocomplete="off" maxlength="200"></p>`
      + `<div id="shop-add-suggest" class="list"></div>`
      + `<p><input class="field" id="shop-add-qty" type="number" min="0" step="any" inputmode="decimal" placeholder="Qty" style="width:5rem"> `
      + `<input class="field" id="shop-add-unit" type="text" placeholder="Unit" autocomplete="off" style="width:5rem"> `
      + `<select class="field" id="shop-add-category"><option value="">Category (optional)</option>`
      + SHOP_CATEGORIES.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("")
      + `</select></p>`
      + `<p><button class="btn btn-primary" type="button" id="shop-add-go">Add to list</button></p><p class="error" id="shop-add-error"></p>`
      // Finish run is its own section now (0.4.0), not part of the
      // add form — it used to sit stacked under "Add to list",
      // below the fold behind the fixed nav.
      + `<h3 class="section-head">Finish the run</h3>`
      + `<p class="muted">Close this list — checked items become purchases, and the rest can carry over.</p>`
      + `<p><button class="btn btn-primary" type="button" id="shop-finish">Finish run</button></p>`;
  } else if (!activeOtherWeek) {
    // A finished week offers Generate again (0.4.0), so a fresh list
    // can be started for it without disturbing the finished run.
    html += `<p><button class="btn btn-primary" type="button" id="shop-generate">Generate a new list for this week</button></p>`;
  }

  ctx.content.innerHTML = html;
  wireShop(ctx, weekStart);
}

function wireShop(ctx, weekStart) {
  ctx.content.querySelectorAll("[data-shop-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.shopView = btn.getAttribute("data-shop-view");
      ctx.notice = ""; ctx.success = "";
      void renderShop(ctx);
    });
  });

  const genBtn = ctx.content.querySelector("#shop-generate");
  if (genBtn) {
    genBtn.addEventListener("click", async () => {
      const restore = busy(genBtn, "Generating…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/shop/generate", "POST", { week_start: weekStart }));
      } catch {
        restore();
        ctx.success = ""; ctx.notice = "Couldn’t generate — check your connection and try again.";
        void renderShop(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderShop(ctx);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderShop(ctx);
    });
  }

  const regenBtn = ctx.content.querySelector("#shop-regenerate");
  if (regenBtn) {
    regenBtn.addEventListener("click", async () => {
      const yes = await confirmPrompt({
        title: "Regenerate the list?",
        message: "Rebuilds the plan-derived lines from the current plan. Lines that come back unchanged keep their check-offs; lines whose quantities changed come back unchecked. Items you added manually stay.",
        confirmLabel: "Regenerate",
      });
      if (!yes || !isCurrent(ctx)) return;
      const restore = busy(regenBtn, "Regenerating…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/shop/generate", "POST", { week_start: weekStart }));
      } catch {
        restore();
        ctx.success = ""; ctx.notice = "Couldn’t regenerate — check your connection and try again.";
        void renderShop(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderShop(ctx);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderShop(ctx);
    });
  }

  // Per-group Regenerate (0.4.0): rebuilds only the lines that
  // meal contributes to, from the current recipe. Other groups'
  // lines, manual lines and carry-over lines are untouched.
  ctx.content.querySelectorAll("[data-shop-regenerate-group]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const date = btn.getAttribute("data-group-date");
      const meal = btn.getAttribute("data-group-meal");
      const yes = await confirmPrompt({
        title: "Regenerate this meal?",
        message: "Rebuilds this meal’s lines from the current recipe. Lines that come back unchanged keep their check-offs; lines whose quantities changed come back unchecked. Other meals’ lines stay as they are.",
        confirmLabel: "Regenerate",
      });
      if (!yes || !isCurrent(ctx)) return;
      const restore = busy(btn, "Regenerating…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/shop/regenerate-group", "POST", { week_start: weekStart, date, meal }));
      } catch {
        restore();
        ctx.success = ""; ctx.notice = "Couldn’t regenerate — check your connection and try again.";
        void renderShop(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderShop(ctx);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderShop(ctx);
    });
  });

  ctx.content.querySelectorAll("[data-shop-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-shop-toggle");
      const next = btn.getAttribute("data-shop-state") === "checked" ? "to_buy" : "checked";
      const restore = busy(btn, "Saving…");
      let res, data;
      try {
        ({ res, data } = await api(`/api/kitchen/shop/lines?id=${encodeURIComponent(id)}`, "PATCH", { state: next }));
      } catch {
        restore();
        ctx.success = ""; ctx.notice = "Couldn’t update that item — check your connection and try again.";
        void renderShop(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderShop(ctx);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderShop(ctx);
    });
  });

  ctx.content.querySelectorAll("[data-shop-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const line = (ctx.shopData.lines || []).find((l) => l.id === btn.getAttribute("data-shop-edit"));
      if (line) openLineEditor(ctx, line);
    });
  });

  ctx.content.querySelectorAll("[data-shop-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-shop-remove");
      const name = btn.getAttribute("data-shop-name");
      const yes = await confirmPrompt({
        title: "Remove this item?",
        message: `Remove ${escapeHTML(name)} from the shopping list?`,
        confirmLabel: "Remove",
      });
      if (!yes || !isCurrent(ctx)) return;
      let res, data;
      try {
        ({ res, data } = await api(`/api/kitchen/shop/lines?id=${encodeURIComponent(id)}`, "DELETE"));
      } catch {
        ctx.success = ""; ctx.notice = "Couldn’t remove that item — check your connection and try again.";
        void renderShop(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderShop(ctx);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderShop(ctx);
    });
  });

  const addName = ctx.content.querySelector("#shop-add-name");
  const addSuggest = ctx.content.querySelector("#shop-add-suggest");
  const addBtn = ctx.content.querySelector("#shop-add-go");
  if (addName && addBtn) {
    let picked = null;
    wireItemSuggest(ctx, addName, addSuggest, (it) => {
      picked = it;
      addName.value = it.name;
      const catSel = ctx.content.querySelector("#shop-add-category");
      if (catSel && it.category && !catSel.value) catSel.value = it.category;
    });
    addBtn.addEventListener("click", async () => {
      const errEl = ctx.content.querySelector("#shop-add-error");
      const name = addName.value.trim();
      if (!name) {
        if (errEl) errEl.textContent = "Give the item a name first.";
        return;
      }
      const qtyRaw = ctx.content.querySelector("#shop-add-qty").value.trim();
      const qty = qtyRaw === "" ? null : Number(qtyRaw);
      if (qty !== null && (!Number.isFinite(qty) || qty <= 0)) {
        if (errEl) errEl.textContent = "Quantity must be a positive number.";
        return;
      }
      const payload = {
        quantity: qty,
        unit: ctx.content.querySelector("#shop-add-unit").value.trim() || null,
        category: ctx.content.querySelector("#shop-add-category").value || null,
      };
      if (picked && picked.name === name) payload.item_id = picked.id;
      else payload.name = name;
      const restore = busy(addBtn, "Adding…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/shop/lines", "POST", payload));
      } catch {
        restore();
        if (errEl) errEl.textContent = "Couldn’t add that item — check your connection and try again.";
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        if (errEl) errEl.textContent = friendlyError(data);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderShop(ctx);
    });
  }

  const finishBtn = ctx.content.querySelector("#shop-finish");
  if (finishBtn) {
    finishBtn.addEventListener("click", () => openFinishRun(ctx, weekStart));
  }
}

// Edit a line's quantity / unit / category. Editing a quantity clears
// the rounding flag server-side — the planner took ownership.
function openLineEditor(ctx, line) {
  const body = document.createElement("div");
  body.innerHTML = `<p><label class="muted">Quantity</label><br><input class="field" id="le-qty" type="number" min="0" step="any" inputmode="decimal" style="width:6rem" value="${line.quantity ?? ""}"></p>`
    + `<p><label class="muted">Unit</label><br><input class="field" id="le-unit" type="text" autocomplete="off" style="width:6rem" value="${escapeHTML(line.unit || "")}"></p>`
    + `<p><label class="muted">Category</label><br><select class="field" id="le-category"><option value="">No category</option>`
    + SHOP_CATEGORIES.map((c) => `<option value="${escapeHTML(c)}"${line.category === c ? " selected" : ""}>${escapeHTML(c)}</option>`).join("")
    + `</select></p>`
    + `<p class="error" id="le-error"></p>`;
  const close = openSheet({
    title: `Edit ${line.display_name}`,
    body,
    actions: [{ label: "Cancel", kind: "ghost" }],
  });
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-primary";
  saveBtn.textContent = "Save";
  body.appendChild(saveBtn);
  saveBtn.addEventListener("click", async () => {
    const errEl = body.querySelector("#le-error");
    const qtyRaw = body.querySelector("#le-qty").value.trim();
    const qty = qtyRaw === "" ? null : Number(qtyRaw);
    if (qty !== null && (!Number.isFinite(qty) || qty <= 0)) {
      errEl.textContent = "Quantity must be a positive number.";
      return;
    }
    const restore = busy(saveBtn, "Saving…");
    let res, data;
    try {
      ({ res, data } = await api(`/api/kitchen/shop/lines?id=${encodeURIComponent(line.id)}`, "PATCH", {
        quantity: qty,
        unit: body.querySelector("#le-unit").value.trim() || null,
        category: body.querySelector("#le-category").value || null,
      }));
    } catch {
      restore();
      errEl.textContent = "Couldn’t save — check your connection and try again.";
      return;
    }
    if (!res.ok || !data.ok) {
      restore();
      errEl.textContent = friendlyError(data);
      return;
    }
    close();
    ctx.notice = ""; ctx.success = "";
    void renderShop(ctx);
  });
}

// Finish run sheet: run date (default today), store, one optional
// price per checked line, carry-over checkboxes for to-buy items
// (checked by default). Only finishing creates purchases.
function openFinishRun(ctx, weekStart) {
  const data = ctx.shopData;
  const lines = data.lines || [];
  const checked = lines.filter((l) => l.state === "checked");
  const toBuy = lines.filter((l) => l.state === "to_buy");
  const body = document.createElement("div");
  let html = `<p class="muted">Week of ${shortDateLabel(weekStart)} · ${checked.length} checked, ${toBuy.length} still to buy.</p>`
    + `<p><label class="muted">Run date</label><br><input class="field" id="finish-date" type="date" value="${localTodayStr()}" style="width:10rem">`
    + `<br><span class="muted" id="finish-date-label">${escapeHTML(longDateLabel(localTodayStr()))}</span></p>`
    + `<p><label class="muted">Store (optional)</label><br><input class="field" id="finish-store" type="text" placeholder="Store" autocomplete="off" maxlength="100"></p>`;
  if (checked.length > 0) {
    html += `<h3 class="section-head">Prices (optional, per checked item)</h3>`;
    for (const l of checked) {
      const qty = qtyLabel(l);
      html += `<p><label class="muted">${escapeHTML(l.display_name)}${qty ? ` — ${escapeHTML(qty)}` : ""}</label><br>`
        + `<input class="field finish-price" data-line-id="${escapeHTML(l.id)}" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Price" style="width:8rem"></p>`;
    }
  } else {
    html += `<p class="muted">Nothing checked — finishing records no purchases.</p>`;
  }
  if (toBuy.length > 0) {
    html += `<h3 class="section-head">Carry over to the next list?</h3><p class="muted">Ticked items carry over; the rest are archived with this run as not bought.</p>`;
    for (const l of toBuy) {
      const qty = qtyLabel(l);
      html += `<p><label><input type="checkbox" class="finish-carry" data-line-id="${escapeHTML(l.id)}" checked> ${escapeHTML(l.display_name)}${qty ? ` — ${escapeHTML(qty)}` : ""}</label></p>`;
    }
  }
  html += `<p class="error" id="finish-error"></p>`;
  body.innerHTML = html;
  // Keep the formatted date line in step with the native picker.
  const dateInput = body.querySelector("#finish-date");
  const dateLabel = body.querySelector("#finish-date-label");
  if (dateInput && dateLabel) {
    dateInput.addEventListener("change", () => {
      dateLabel.textContent = longDateLabel(dateInput.value);
    });
  }
  const close = openSheet({
    title: "Finish run",
    body,
    actions: [
      { label: "Cancel", kind: "ghost" },
      {
        label: "Finish run",
        kind: "primary",
        onClick: () => {
          void (async () => {
            const errEl = body.querySelector("#finish-error");
            const runDate = body.querySelector("#finish-date").value;
            const store = body.querySelector("#finish-store").value.trim();
            const prices = [...body.querySelectorAll(".finish-price")].map((input) => {
              const raw = input.value.trim();
              return raw === "" ? null : { line_id: input.getAttribute("data-line-id"), price: Number(raw) };
            }).filter((p) => p !== null);
            if (prices.some((p) => !Number.isFinite(p.price) || p.price < 0)) {
              ctx.success = ""; ctx.notice = "Prices must be 0 or more.";
              close();
              void renderShop(ctx);
              return;
            }
            const carryOver = [...body.querySelectorAll(".finish-carry")]
              .filter((box) => box.checked)
              .map((box) => box.getAttribute("data-line-id"));
            let res, data;
            try {
              ({ res, data } = await api("/api/kitchen/shop/finish", "POST", {
                run_date: runDate || undefined,
                store: store || undefined,
                prices,
                carry_over: carryOver,
              }));
            } catch {
              ctx.success = ""; ctx.notice = "Couldn’t finish the run — check your connection and try again.";
              void renderShop(ctx);
              return;
            }
            if (!res.ok || !data.ok) {
              ctx.success = ""; ctx.notice = friendlyError(data);
              void renderShop(ctx);
              return;
            }
            ctx.success = `Finished — ${data.purchased} purchased, ${data.carried_over} carried over to the next list.`;
            ctx.notice = "";
            void renderShop(ctx);
          })();
        },
      },
    ],
  });
}

async function renderPantry(ctx) {
  ctx.content.innerHTML = loadingHTML("pantry");
  let res, data;
  try {
    ({ res, data } = await api("/api/kitchen/pantry"));
  } catch {
    if (!isCurrent(ctx)) return;
    ctx.content.innerHTML = loadErrorHTML(ctx, "pantry");
    wireRetry(ctx, () => renderPantry(ctx));
    return;
  }
  if (!isCurrent(ctx)) return;
  if (res.status === 401) {
    ctx.content.innerHTML = sessionEndedHTML();
    return;
  }
  if (!res.ok || !data.ok) {
    ctx.content.innerHTML = loadErrorHTML(ctx, "pantry");
    wireRetry(ctx, () => renderPantry(ctx));
    return;
  }
  ctx.pantryItems = data.items || [];

  let html = noticeHTML(ctx)
    + `<h2 class="section-head">Pantry</h2>`
    + `<p class="muted">Out puts the item back on the shopping list.</p>`;
  if (ctx.pantryItems.length === 0) {
    html += `<div class="empty-state"><h2>No pantry staples yet</h2><p>Add the things you usually keep on hand.</p></div>`;
  } else {
    let currentCat = null;
    for (const it of ctx.pantryItems) {
      const cat = shopGroupFor({ category: it.category });
      if (cat !== currentCat) {
        if (currentCat !== null) html += `</div>`;
        html += `<h3 class="section-head">${cat}</h3><div class="list">`;
        currentCat = cat;
      }
      const lb = it.last_bought_date ? `Last bought ${daysAgoLabel(it.last_bought_date)}` : "";
      // Segmented Have / Out (0.4.0): the old single button read as a
      // status badge, not an action — both states are shown, the
      // current one filled.
      html += `<div class="list-row" style="flex-wrap:wrap"><span style="flex:1;min-width:8rem"><strong>${escapeHTML(it.name)}</strong>`
        + (lb ? `<br><span class="muted">${escapeHTML(lb)}</span>` : "")
        + `</span>`
        + `<span class="segmented"><button class="btn ${it.on_hand === "have" ? "btn-primary" : "btn-ghost"}" type="button" data-pantry-set="${escapeHTML(it.item_id)}" data-pantry-state="have">Have</button>`
        + `<button class="btn ${it.on_hand === "out" ? "btn-primary" : "btn-ghost"}" type="button" data-pantry-set="${escapeHTML(it.item_id)}" data-pantry-state="out">Out</button></span>`
        + `<button class="btn btn-ghost" type="button" data-pantry-remove="${escapeHTML(it.item_id)}" data-pantry-name="${escapeHTML(it.name)}">Remove</button></div>`;
    }
    if (currentCat !== null) html += `</div>`;
  }

  html += `<h3 class="section-head">Add a staple</h3>`
    + `<p><input class="field" id="pantry-add-name" type="text" placeholder="Item name" autocomplete="off" maxlength="200"></p>`
    + `<div id="pantry-add-suggest" class="list"></div>`
    + `<p><select class="field" id="pantry-add-category"><option value="">Category (optional)</option>`
    + SHOP_CATEGORIES.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("")
    + `</select> `
    + `<select class="field" id="pantry-add-state"><option value="have">Have</option><option value="out">Out</option></select></p>`
    + `<p><button class="btn btn-primary" type="button" id="pantry-add-go">Add staple</button></p><p class="error" id="pantry-add-error"></p>`;

  ctx.content.innerHTML = html;
  wirePantry(ctx);
}

function wirePantry(ctx) {
  ctx.content.querySelectorAll("[data-pantry-set]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.getAttribute("data-pantry-set");
      const next = btn.getAttribute("data-pantry-state");
      const restore = busy(btn, "Saving…");
      let res, data;
      try {
        ({ res, data } = await api(`/api/kitchen/pantry?item_id=${encodeURIComponent(itemId)}`, "PATCH", { on_hand: next }));
      } catch {
        restore();
        ctx.success = ""; ctx.notice = "Couldn’t update that staple — check your connection and try again.";
        void renderPantry(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderPantry(ctx);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderPantry(ctx);
    });
  });

  ctx.content.querySelectorAll("[data-pantry-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const itemId = btn.getAttribute("data-pantry-remove");
      const name = btn.getAttribute("data-pantry-name");
      const yes = await confirmPrompt({
        title: "Remove this staple?",
        message: `Remove ${escapeHTML(name)} from the pantry? The shopping list is left alone.`,
        confirmLabel: "Remove",
      });
      if (!yes || !isCurrent(ctx)) return;
      let res, data;
      try {
        ({ res, data } = await api(`/api/kitchen/pantry?item_id=${encodeURIComponent(itemId)}`, "DELETE"));
      } catch {
        ctx.success = ""; ctx.notice = "Couldn’t remove that staple — check your connection and try again.";
        void renderPantry(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        ctx.success = ""; ctx.notice = friendlyError(data);
        void renderPantry(ctx);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderPantry(ctx);
    });
  });

  const addName = ctx.content.querySelector("#pantry-add-name");
  const addSuggest = ctx.content.querySelector("#pantry-add-suggest");
  const addBtn = ctx.content.querySelector("#pantry-add-go");
  if (addName && addBtn) {
    let picked = null;
    wireItemSuggest(ctx, addName, addSuggest, (it) => {
      picked = it;
      addName.value = it.name;
      const catSel = ctx.content.querySelector("#pantry-add-category");
      if (catSel && it.category && !catSel.value) catSel.value = it.category;
    });
    addBtn.addEventListener("click", async () => {
      const errEl = ctx.content.querySelector("#pantry-add-error");
      const name = addName.value.trim();
      if (!name) {
        if (errEl) errEl.textContent = "Give the staple a name first.";
        return;
      }
      const payload = {
        category: ctx.content.querySelector("#pantry-add-category").value || null,
        on_hand: ctx.content.querySelector("#pantry-add-state").value,
      };
      if (picked && picked.name === name) payload.item_id = picked.id;
      else payload.name = name;
      const restore = busy(addBtn, "Adding…");
      let res, data;
      try {
        ({ res, data } = await api("/api/kitchen/pantry", "POST", payload));
      } catch {
        restore();
        if (errEl) errEl.textContent = "Couldn’t add that staple — check your connection and try again.";
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        if (errEl) errEl.textContent = friendlyError(data);
        return;
      }
      ctx.notice = ""; ctx.success = "";
      void renderPantry(ctx);
    });
  }
}
