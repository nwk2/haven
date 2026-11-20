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
    : resolution === "eat_out" ? "Ate out"
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
    const { res, data } = await api("/api/kitchen/next-meal");
    if (!res.ok || !data.ok || !data.next) return null;
    const n = data.next;
    let body = `${cap(n.meal)} · ${n.recipe_name} — ${weekdayLong(n.date)}, ${shortDateLabel(n.date)}`;
    if (n.cook_minutes) body += ` · ${n.cook_minutes} min`;
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
    if (retry) retry.addEventListener("click", () => { ctx.notice = ""; void render(); });
  });
}

// --- Shared render helpers ---

function isCurrent(ctx) {
  return ctx.gen === mountSeq;
}
function noticeHTML(ctx) {
  return ctx.notice ? `<p class="error">${escapeHTML(ctx.notice)}</p>` : "";
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
  if (btn) btn.addEventListener("click", () => { ctx.notice = ""; void rerender(); });
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
    invalid_cook_minutes: "Cook time must be a positive number of minutes.",
    invalid_servings: "Servings must be a positive number.",
    recipe_not_found: "That recipe no longer exists.",
    invalid_leftover_source: "Pick an earlier planned recipe as the leftovers source.",
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
      html += `<div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(weekdayShort(u.date))} ${escapeHTML(shortDateLabel(u.date))} · ${escapeHTML(cap(u.meal))} — ${escapeHTML(u.recipe_name || "")}</span>`
        + resolveButtonsHTML(u.week_start, u.date, u.meal)
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
  // Recipe slot.
  const r = m.recipe;
  const name = escapeHTML(m.recipe_name || (r && r.name) || "");
  let html = `<div class="list"><div class="list-row" style="flex-wrap:wrap"><div style="flex:1;min-width:12rem">`
    + `<strong>${name}</strong>`;
  const bits = [];
  if (r && r.cook_minutes) bits.push(`${r.cook_minutes} min`);
  if (r && r.usual_cook_name) bits.push(`usually ${escapeHTML(r.usual_cook_name)}`);
  if (m.servings) bits.push(`${m.servings} servings`);
  if (bits.length > 0) html += `<br><span class="muted">${bits.join(" · ")}</span>`;
  if (m.resolution) {
    html += `<br><span class="muted">${escapeHTML(resolutionLabel(m.resolution))}</span>`;
  }
  html += `</div>`;
  if (m.resolution) {
    html += `<button class="btn btn-ghost" type="button" data-resolve="null" data-week="${escapeHTML(m.week_start || "")}" data-date="${escapeHTML(m.date)}" data-meal="${escapeHTML(m.meal)}">Clear</button>`;
  } else {
    html += resolveButtonsHTML(m.week_start || "", m.date, m.meal);
    html += `<button class="btn btn-ghost" type="button" data-cook-else="${escapeHTML(m.date)}" data-meal="${escapeHTML(m.meal)}">Cook something else</button>`;
  }
  html += `</div>`;
  if (r && ((r.ingredients && r.ingredients.length > 0) || (r.steps && r.steps.length > 0))) {
    html += `<details style="padding:0.5rem 1rem"><summary>Cooking view — ingredients &amp; steps</summary>`;
    if (r.ingredients && r.ingredients.length > 0) {
      html += `<h3 class="section-head">Ingredients</h3><ul>`;
      for (const ing of r.ingredients) {
        const qty = [ing.quantity, ing.unit].filter((x) => x !== null && x !== undefined && x !== "").join(" ");
        html += `<li>${qty ? `${escapeHTML(String(qty))} ` : ""}${escapeHTML(ing.name)}${ing.prep_note ? ` — ${escapeHTML(ing.prep_note)}` : ""}</li>`;
      }
      html += `</ul>`;
    }
    if (r.steps && r.steps.length > 0) {
      html += `<h3 class="section-head">Steps</h3><ol>`;
      for (const s of r.steps) {
        html += `<li>${escapeHTML(s.text)}${s.duration_minutes ? ` <span class="muted">(${s.duration_minutes} min)</span>` : ""}</li>`;
      }
      html += `</ol>`;
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
        ctx.notice = "Couldn’t record that — check your connection and try again.";
        void renderToday(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.notice = friendlyError(data);
        void renderToday(ctx);
        return;
      }
      // Mark cooked: offer the leftovers shortcut for tomorrow's same meal.
      if (resolution === "cooked") {
        const slot = (ctx.todayData.meals || []).find((x) => x.date === date && x.meal === meal);
        const recipeName = slot ? (slot.recipe_name || "") : "";
        await offerLeftoverTomorrow(ctx, week, date, meal, recipeName);
      }
      ctx.notice = "";
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
      ctx.notice = "";
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
      ctx.notice = "";
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
    + `<p><button class="btn ${ctx.planView === "this" ? "btn-primary" : "btn-ghost"}" type="button" data-week-view="this">This week</button> `
    + `<button class="btn ${ctx.planView === "next" ? "btn-primary" : "btn-ghost"}" type="button" data-week-view="next">Next week</button></p>`;

  if (ctx.planWarnings.length > 0) {
    html += `<div class="list">` + ctx.planWarnings.map((w) =>
      `<div class="list-row"><span>⚠ <strong>${escapeHTML(w.recipe_name)}</strong> — ${escapeHTML(w.detail)}</span></div>`
    ).join("") + `</div>`;
  }

  const shownMeals = MEALS.filter((m) => ctx.planDays.some((d) => d.meal === m));
  for (const meal of shownMeals) {
    const days = ctx.planDays.filter((d) => d.meal === meal);
    const plannedDates = new Set(days.map((d) => d.date));
    const blank = 7 - plannedDates.size;
    html += `<h3 class="section-head">${cap(meal)}${blank > 0 ? ` <span class="muted">— ${blank} day${blank === 1 ? "" : "s"} not planned yet</span>` : ""}</h3>`;
    html += `<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:0.25rem;margin-bottom:0.25rem">`;
    for (let i = 0; i < 7; i++) {
      const date = addDaysStr(weekStart, i);
      html += `<div class="muted" style="text-align:center;font-size:0.8rem">${weekdayShort(date)} ${parseLocalDate(date).getDate()}</div>`;
    }
    html += `</div><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:0.25rem">`;
    for (let i = 0; i < 7; i++) {
      const date = addDaysStr(weekStart, i);
      const d = days.find((x) => x.date === date);
      const label = !d ? "+"
        : d.state === "recipe" ? (d.recipe_name || "")
        : d.state === "eat_out" ? "Eat out" : "Leftovers";
      const style = d && d.state === "recipe" && d.resolution
        ? "background:var(--card);border:1px solid var(--border);border-radius:0.6rem;padding:0.5rem 0.25rem;min-height:3.5rem;font:inherit;font-size:0.8rem;text-align:left;cursor:pointer;color:var(--ink-muted)"
        : "background:var(--card);border:1px solid var(--border);border-radius:0.6rem;padding:0.5rem 0.25rem;min-height:3.5rem;font:inherit;font-size:0.8rem;text-align:left;cursor:pointer;color:var(--ink)";
      html += `<button type="button" style="${style}" data-cell-date="${escapeHTML(date)}" data-cell-meal="${escapeHTML(meal)}">${escapeHTML(label)}${d && d.resolution ? `<br><span class="muted">${escapeHTML(resolutionLabel(d.resolution))}</span>` : ""}</button>`;
    }
    html += `</div>`;
  }

  const hiddenMeals = MEALS.filter((m) => !shownMeals.includes(m));
  if (hiddenMeals.length > 0) {
    html += `<h3 class="section-head">Add a meal to this week</h3><p>`
      + hiddenMeals.map((m) => `<button class="btn btn-ghost" type="button" data-add-meal="${escapeHTML(m)}">Plan ${escapeHTML(m)}</button> `).join("")
      + `</p><p class="muted">Planning the first day adds the meal’s row — the other days fill in from there.</p>`;
  }

  if (ctx.planView === "this") {
    html += `<p><button class="btn btn-primary" type="button" id="copy-forward">Copy this week to next week</button></p>`;
  }

  ctx.content.innerHTML = html;
  wirePlan(ctx, weekStart);
}

function wirePlan(ctx, weekStart) {
  ctx.content.querySelectorAll("[data-week-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      ctx.planView = btn.getAttribute("data-week-view");
      ctx.notice = "";
      void renderPlan(ctx);
    });
  });
  ctx.content.querySelectorAll("[data-cell-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const date = btn.getAttribute("data-cell-date");
      const meal = btn.getAttribute("data-cell-meal");
      const existing = ctx.planDays.find((d) => d.date === date && d.meal === meal);
      openSlotPicker(ctx, weekStart, date, meal, existing || null);
    });
  });
  ctx.content.querySelectorAll("[data-add-meal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openSlotPicker(ctx, weekStart, weekStart, btn.getAttribute("data-add-meal"), null);
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
        ctx.notice = "Couldn’t copy the week — check your connection and try again.";
        void renderPlan(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.notice = friendlyError(data);
        void renderPlan(ctx);
        return;
      }
      ctx.notice = `Copied ${data.copied} slot${data.copied === 1 ? "" : "s"}, skipped ${data.skipped} already planned.`;
      void renderPlan(ctx);
    });
  }
}

// Slot picker sheet for one (date, meal) cell.
function openSlotPicker(ctx, weekStart, dateStr, meal, existing) {
  const body = document.createElement("div");
  const warningsByRecipe = new Map((ctx.planWarnings || []).map((w) => [w.recipe_id, w.detail]));
  // "Not cooked in a while": never cooked, or last cooked 21+ days before this week.
  const staleCutoff = addDaysStr(weekStart, -21);
  const notAWhile = ctx.recipes.filter((r) => !r.last_cooked || r.last_cooked <= staleCutoff);
  const recent = ctx.recipes.filter((r) => r.last_cooked && r.last_cooked > staleCutoff);

  const recipeButton = (r) => {
    const warn = warningsByRecipe.get(r.id);
    return `<div class="list-row"><span style="flex:1;min-width:0">${escapeHTML(r.name)}`
      + `<br><span class="muted">${escapeHTML(lastCookedLabel(r))} · cooked ${r.times_cooked}×</span>`
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
    ctx.notice = "";
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
      ctx.notice = "";
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
    html += `<div class="empty-state"><p>No recipes yet — add your first one.</p></div>`;
  } else {
    html += `<div class="list">` + active.map((r) =>
      `<div class="list-row" data-recipe-row="${escapeHTML(r.id)}" style="cursor:pointer"><span style="flex:1;min-width:0"><strong>${escapeHTML(r.name)}</strong>`
      + `<br><span class="muted">${escapeHTML(lastCookedLabel(r))} · cooked ${r.times_cooked}×`
      + (r.cook_minutes ? ` · ${r.cook_minutes} min` : "")
      + (r.servings ? ` · ${r.servings} servings` : "")
      + ` · ${r.ingredient_count || 0} ingredient${(r.ingredient_count || 0) === 1 ? "" : "s"} · ${r.step_count || 0} step${(r.step_count || 0) === 1 ? "" : "s"}</span></span></div>`
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
      ctx.notice = "";
      void renderRecipes(ctx);
    });
  }
  ctx.content.querySelectorAll("[data-recipe-row]").forEach((row) => {
    row.addEventListener("click", () => {
      ctx.recipesView = { kind: "detail", id: row.getAttribute("data-recipe-row") };
      ctx.notice = "";
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
        ctx.notice = "Couldn’t restore — check your connection and try again.";
        void renderRecipes(ctx);
        return;
      }
      if (!res.ok || !data.ok) {
        restore();
        ctx.notice = friendlyError(data);
        void renderRecipes(ctx);
        return;
      }
      ctx.notice = "";
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
    + `<p class="muted">${escapeHTML(lastCookedLabel(r))} · cooked ${r.times_cooked}×`
    + (r.cook_minutes ? ` · ${r.cook_minutes} min` : "")
    + (r.servings ? ` · serves ${r.servings}` : "")
    + (r.usual_cook_name ? ` · usually ${escapeHTML(r.usual_cook_name)}` : "")
    + `</p>`;
  if (r.notes) html += `<p>${escapeHTML(r.notes)}</p>`;
  if (r.ingredients && r.ingredients.length > 0) {
    html += `<h3 class="section-head">Ingredients</h3><ul>`;
    for (const ing of r.ingredients) {
      const qty = [ing.quantity, ing.unit].filter((x) => x !== null && x !== undefined && x !== "").join(" ");
      html += `<li>${qty ? `${escapeHTML(String(qty))} ` : ""}${escapeHTML(ing.name)}${ing.prep_note ? ` — ${escapeHTML(ing.prep_note)}` : ""}</li>`;
    }
    html += `</ul>`;
  }
  if (r.steps && r.steps.length > 0) {
    html += `<h3 class="section-head">Steps</h3><ol>`;
    for (const s of r.steps) {
      html += `<li>${escapeHTML(s.text)}${s.duration_minutes ? ` <span class="muted">(${s.duration_minutes} min)</span>` : ""}</li>`;
    }
    html += `</ol>`;
  }
  if ((!r.ingredients || r.ingredients.length === 0) && (!r.steps || r.steps.length === 0)) {
    html += `<p class="muted">No ingredients or steps yet — edit to add them.</p>`;
  }
  html += `<p><button class="btn btn-primary" type="button" id="edit-recipe">Edit</button> `
    + `<button class="btn btn-ghost" type="button" id="archive-recipe">Archive</button></p>`;
  ctx.content.innerHTML = html;

  ctx.content.querySelector("#back-to-recipes").addEventListener("click", () => {
    ctx.recipesView = { kind: "list" };
    ctx.notice = "";
    void renderRecipes(ctx);
  });
  ctx.content.querySelector("#edit-recipe").addEventListener("click", () => {
    ctx.recipesView = { kind: "form", id };
    ctx.notice = "";
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
      ctx.notice = "Couldn’t archive — check your connection and try again.";
      void renderRecipes(ctx);
      return;
    }
    if (!aRes.ok || !aData.ok) {
      ctx.notice = friendlyError(aData);
      void renderRecipes(ctx);
      return;
    }
    ctx.recipesView = { kind: "list" };
    ctx.notice = "";
    void renderRecipes(ctx);
  });
}

function ingredientRowHTML(ing) {
  const i = ing || {};
  return `<div class="list-row rf-ing-row" style="flex-wrap:wrap">`
    + `<input class="field ing-name" style="flex:2;min-width:8rem" type="text" placeholder="Ingredient" autocomplete="off" value="${escapeHTML(i.name || "")}">`
    + `<input class="field ing-qty" style="width:4.5rem" type="number" min="0" step="any" inputmode="decimal" placeholder="Qty" value="${i.quantity ?? ""}">`
    + `<input class="field ing-unit" style="width:4rem" type="text" placeholder="Unit" autocomplete="off" value="${escapeHTML(i.unit || "")}">`
    + `<input class="field ing-prep" style="flex:1;min-width:8rem" type="text" placeholder="Prep note" autocomplete="off" value="${escapeHTML(i.prep_note || "")}">`
    + `<button class="btn btn-ghost rf-remove" type="button">Remove</button></div>`;
}
function stepRowHTML(step) {
  const s = step || {};
  return `<div class="list-row rf-step-row" style="flex-wrap:wrap">`
    + `<input class="field step-text" style="flex:2;min-width:10rem" type="text" placeholder="Step" autocomplete="off" value="${escapeHTML(s.text || "")}">`
    + `<input class="field step-duration" style="width:4.5rem" type="number" min="0" step="1" inputmode="numeric" placeholder="Min" value="${s.duration_minutes ?? ""}">`
    + `<button class="btn btn-ghost rf-up" type="button" title="Move up">↑</button>`
    + `<button class="btn btn-ghost rf-down" type="button" title="Move down">↓</button>`
    + `<button class="btn btn-ghost rf-remove" type="button">Remove</button></div>`;
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
  if (!ctx.members) {
    try {
      const { res, data } = await api("/api/household");
      if (!isCurrent(ctx)) return;
      if (res.status === 401) {
        ctx.content.innerHTML = sessionEndedHTML();
        return;
      }
      if (res.ok && data.ok) ctx.members = data.members || [];
    } catch {
      // The cook picker is optional — the form still works without it.
      ctx.members = [];
    }
  }
  if (!isCurrent(ctx)) return;

  const r = recipe || {};
  const members = ctx.members || [];
  const ingredients = r.ingredients && r.ingredients.length > 0 ? r.ingredients : [{}];
  const steps = r.steps && r.steps.length > 0 ? r.steps : [{}];

  let html = noticeHTML(ctx)
    + `<h2 class="section-head">${editingId ? "Edit recipe" : "New recipe"}</h2>`
    + `<p class="error" id="rf-error"></p>`
    + `<p><label class="muted">Name</label><br><input class="field" id="rf-name" type="text" autocomplete="off" maxlength="200" value="${escapeHTML(r.name || "")}"></p>`
    + `<p><label class="muted">Usual cook</label><br><select class="field" id="rf-cook"><option value="">No usual cook</option>`
    + members.map((m) => `<option value="${escapeHTML(m.id)}"${r.usual_cook_id === m.id ? " selected" : ""}>${escapeHTML(m.name)}</option>`).join("")
    + `</select></p>`
    + `<p><label class="muted">Cook time (minutes)</label><br><input class="field" id="rf-minutes" type="number" min="1" max="1440" inputmode="numeric" style="width:8rem" value="${r.cook_minutes ?? ""}"></p>`
    + `<p><label class="muted">Servings</label><br><input class="field" id="rf-servings" type="number" min="1" max="100" inputmode="numeric" style="width:8rem" value="${r.servings ?? ""}"></p>`
    + `<p><label class="muted">Notes</label><br><textarea class="field" id="rf-notes" rows="3">${escapeHTML(r.notes || "")}</textarea></p>`
    + `<h3 class="section-head">Ingredients</h3><div id="rf-ingredients" class="list">`
    + ingredients.map(ingredientRowHTML).join("") + `</div>`
    + `<p><button class="btn btn-ghost" type="button" id="rf-add-ing">Add ingredient</button></p>`
    + `<h3 class="section-head">Steps</h3><div id="rf-steps" class="list">`
    + steps.map(stepRowHTML).join("") + `</div>`
    + `<p><button class="btn btn-ghost" type="button" id="rf-add-step">Add step</button></p>`
    + `<p><button class="btn btn-primary" type="button" id="rf-save">${editingId ? "Save changes" : "Create recipe"}</button> `
    + `<button class="btn btn-ghost" type="button" id="rf-cancel">Cancel</button></p>`;
  ctx.content.innerHTML = html;

  // Row editors: delegated clicks handle rows added later too.
  const ingHost = ctx.content.querySelector("#rf-ingredients");
  const stepHost = ctx.content.querySelector("#rf-steps");
  ingHost.addEventListener("click", (event) => {
    if (event.target.classList.contains("rf-remove")) {
      event.target.closest(".rf-ing-row").remove();
    }
  });
  stepHost.addEventListener("click", (event) => {
    const row = event.target.closest(".rf-step-row");
    if (!row) return;
    if (event.target.classList.contains("rf-remove")) row.remove();
    else if (event.target.classList.contains("rf-up") && row.previousElementSibling) {
      stepHost.insertBefore(row, row.previousElementSibling);
    } else if (event.target.classList.contains("rf-down") && row.nextElementSibling) {
      stepHost.insertBefore(row.nextElementSibling, row);
    }
  });
  ctx.content.querySelector("#rf-add-ing").addEventListener("click", () => {
    ingHost.insertAdjacentHTML("beforeend", ingredientRowHTML({}));
  });
  ctx.content.querySelector("#rf-add-step").addEventListener("click", () => {
    stepHost.insertAdjacentHTML("beforeend", stepRowHTML({}));
  });
  ctx.content.querySelector("#rf-cancel").addEventListener("click", () => {
    ctx.recipesView = editingId ? { kind: "detail", id: editingId } : { kind: "list" };
    ctx.notice = "";
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
    const cookMinutes = numOrNull(ctx.content.querySelector("#rf-minutes").value.trim(), 1440);
    const servings = numOrNull(ctx.content.querySelector("#rf-servings").value.trim(), 100);
    if (cookMinutes === undefined || servings === undefined) {
      errEl.textContent = "Cook time and servings must be positive numbers.";
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
      };
    }).filter((ing) => ing.name.length > 0);
    const steps = [...stepHost.querySelectorAll(".rf-step-row")].map((row) => {
      const durRaw = row.querySelector(".step-duration").value.trim();
      const dur = durRaw === "" ? null : Math.round(Number(durRaw));
      return {
        text: row.querySelector(".step-text").value.trim(),
        duration_minutes: Number.isFinite(dur) && dur > 0 ? dur : null,
      };
    }).filter((s) => s.text.length > 0);
    const payload = {
      name,
      usual_cook_id: ctx.content.querySelector("#rf-cook").value || null,
      cook_minutes: cookMinutes,
      servings,
      notes: ctx.content.querySelector("#rf-notes").value.trim(),
      ingredients,
      steps,
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

async function renderShop(ctx) {
  ctx.content.innerHTML = `<div class="empty-state"><h2>Shop</h2>`
    + `<p>The shopping list arrives in Batch 4.</p></div>`;
}

async function renderPantry(ctx) {
  ctx.content.innerHTML = `<div class="empty-state"><h2>Pantry</h2>`
    + `<p>Pantry arrives in Batch 4.</p></div>`;
}
