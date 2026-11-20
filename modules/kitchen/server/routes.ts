// Kitchen module server routes — Batch 3: Recipes, Plan, Today.
// Batch 4: Shop derivation + Pantry (below, before the route table).
// (Haven spec §5–9; Cook Board spec §3–4, §8, §10.)
//
// Handlers receive the shell auth context (user + household) — modules run
// no auth of their own (spec §2). The shell guarantees ctx.household is
// non-null before dispatching a module route, and every query below is
// household-scoped.
//
// Route shape: the shell matches module routes by exact path + method, so
// ids travel as query params on the collection path (GET / PATCH / DELETE
// /api/kitchen/recipes?id=…), not as /:id segments.
//
// Design notes (spec §9, Cook Board §10):
// - Last-cooked / times cooked are derived from cook_events, never stored.
// - "Delete" on a recipe is an archive (Cook Board §4: no hard delete in
//   v1) — archived recipes leave the picker but keep their history.
// - plan state is what was PLANNED (recipe / eat_out / leftovers);
//   resolution is what HAPPENED (cooked / eat_out / leftovers / skipped,
//   NULL = not recorded) and only applies to recipe slots.
// - Warnings never block: repeat / recently-cooked are flags on the plan
//   read, not errors on the write.
// - Batching follows the 0.1.9 pattern: independent statements run as one
//   env.DB.batch() round-trip; dependent chains stay sequential. A batch
//   is all-or-nothing under workerd, so a failed ingredient insert rolls
//   the recipe insert back too.
import { nowIso, uid, type AuthContext } from "../../../shell/src/auth.js";

export interface ApiRoute {
  method: string;
  path: string;
  handler: (
    request: Request,
    env: unknown,
    ctx: AuthContext | null,
  ) => Promise<Response> | Response;
}

interface KitchenEnv {
  DB: D1Database;
}

const MEALS = ["breakfast", "lunch", "dinner"] as const;
type Meal = (typeof MEALS)[number];
const RESOLUTIONS = ["cooked", "eat_out", "leftovers", "skipped"] as const;
const DAY_MS = 86400000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
function err(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}
async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// --- Dates (YYYY-MM-DD, UTC) ---
function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return d;
}
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function mondayOf(d: Date): Date {
  const diff = (d.getUTCDay() + 6) % 7; // days since Monday
  return new Date(d.getTime() - diff * DAY_MS);
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}
function isMeal(v: unknown): v is Meal {
  return typeof v === "string" && (MEALS as readonly string[]).includes(v);
}
function mealRank(meal: string): number {
  return meal === "breakfast" ? 0 : meal === "lunch" ? 1 : 2;
}
// Is (date, meal) strictly earlier than (date2, meal2)?
function slotBefore(date: string, meal: Meal, date2: string, meal2: Meal): boolean {
  return date < date2 || (date === date2 && mealRank(meal) < mealRank(meal2));
}

// --- Shared lookups ---
type Rotation = { last_cooked: string | null; times_cooked: number };

// Derived rotation data (spec §9): last-cooked + times cooked per recipe.
async function lastCookedMap(k: KitchenEnv, hid: string): Promise<Map<string, Rotation>> {
  const { results } = await k.DB.prepare(
    "SELECT recipe_id, MAX(date) AS last_cooked, COUNT(*) AS times_cooked " +
      "FROM cook_events WHERE household_id = ? GROUP BY recipe_id",
  )
    .bind(hid)
    .all();
  const map = new Map<string, Rotation>();
  for (const r of results as any[]) {
    map.set(String(r.recipe_id), {
      last_cooked: r.last_cooked ? String(r.last_cooked) : null,
      times_cooked: Number(r.times_cooked) || 0,
    });
  }
  return map;
}

// Household member id -> display name (for usual_cook).
async function memberNames(k: KitchenEnv, hid: string): Promise<Map<string, string>> {
  const { results } = await k.DB.prepare(
    "SELECT u.id AS id, u.name AS name FROM household_members m " +
      "JOIN users u ON u.id = m.user_id WHERE m.household_id = ?",
  )
    .bind(hid)
    .all();
  const map = new Map<string, string>();
  for (const r of results as any[]) map.set(String(r.id), String(r.name));
  return map;
}

function canonicalName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Resolve ingredient names to canonical shop_items rows, creating the
// missing ones. Two batched round-trips: one SELECT batch for all names,
// one INSERT batch for the ones not found. Returns canonical name -> id.
async function resolveItems(k: KitchenEnv, hid: string, names: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(names.map(canonicalName).filter(Boolean))];
  const ids = new Map<string, string>();
  if (unique.length === 0) return ids;
  const found = await k.DB.batch(
    unique.map((n) =>
      k.DB.prepare(
        "SELECT id FROM shop_items WHERE household_id = ? AND canonical_name = ? AND variant = ''",
      ).bind(hid, n),
    ),
  );
  const missing: string[] = [];
  found.forEach((res, i) => {
    const row: any = res.results[0];
    if (row) ids.set(unique[i], String(row.id));
    else missing.push(unique[i]);
  });
  if (missing.length > 0) {
    const newIds = missing.map(() => uid());
    await k.DB.batch(
      missing.map((n, i) =>
        k.DB.prepare(
          "INSERT INTO shop_items (id, household_id, canonical_name, variant, created_at) VALUES (?, ?, ?, '', ?)",
        ).bind(newIds[i], hid, n, nowIso()),
      ),
    );
    missing.forEach((n, i) => ids.set(n, newIds[i]));
  }
  return ids;
}

function recipeShape(
  r: any,
  lc: Map<string, Rotation>,
  cooks: Map<string, string>,
  extra: Record<string, unknown> = {},
) {
  const rot = lc.get(String(r.id)) || { last_cooked: null, times_cooked: 0 };
  return {
    id: String(r.id),
    name: String(r.name),
    usual_cook_id: r.usual_cook_id ? String(r.usual_cook_id) : null,
    usual_cook_name: r.usual_cook_id ? cooks.get(String(r.usual_cook_id)) || null : null,
    cook_minutes: r.cook_minutes ?? null,
    servings: r.servings ?? null,
    notes: String(r.notes || ""),
    photo_r2_key: r.photo_r2_key ? String(r.photo_r2_key) : null,
    archived_at: r.archived_at ? String(r.archived_at) : null,
    created_at: String(r.created_at),
    last_cooked: rot.last_cooked,
    times_cooked: rot.times_cooked,
    ...extra,
  };
}

// Full recipe detail: row + ingredients (with canonical names) + steps.
async function fetchRecipeFull(k: KitchenEnv, hid: string, id: string): Promise<any | null> {
  const [recipeRes, ingRes, stepRes, evRes, membersRes] = await k.DB.batch([
    k.DB.prepare("SELECT * FROM cook_recipes WHERE id = ? AND household_id = ?").bind(id, hid),
    k.DB.prepare(
      "SELECT i.*, s.canonical_name AS item_name, s.category AS item_category FROM cook_recipe_ingredients i " +
        "JOIN shop_items s ON s.id = i.item_id WHERE i.recipe_id = ? ORDER BY i.sort_order",
    ).bind(id),
    k.DB.prepare("SELECT * FROM cook_recipe_steps WHERE recipe_id = ? ORDER BY step_no").bind(id),
    k.DB.prepare(
      "SELECT MAX(date) AS last_cooked, COUNT(*) AS times_cooked FROM cook_events WHERE household_id = ? AND recipe_id = ?",
    ).bind(hid, id),
    k.DB.prepare(
      "SELECT u.id AS id, u.name AS name FROM household_members m " +
        "JOIN users u ON u.id = m.user_id WHERE m.household_id = ?",
    ).bind(hid),
  ]);
  const r: any = recipeRes.results[0];
  if (!r) return null;
  const cooks = new Map<string, string>();
  for (const m of membersRes.results as any[]) cooks.set(String(m.id), String(m.name));
  const ev: any = evRes.results[0];
  const lc = new Map<string, Rotation>([
    [
      String(r.id),
      {
        last_cooked: ev?.last_cooked ? String(ev.last_cooked) : null,
        times_cooked: Number(ev?.times_cooked) || 0,
      },
    ],
  ]);
  return {
    ...recipeShape(r, lc, cooks),
    ingredients: (ingRes.results as any[]).map((i: any) => ({
      item_id: String(i.item_id),
      name: String(i.item_name),
      quantity: i.quantity ?? null,
      unit: i.unit ?? null,
      prep_note: i.prep_note ?? null,
      category: i.item_category ? String(i.item_category) : null,
      sort_order: Number(i.sort_order),
    })),
    steps: (stepRes.results as any[]).map((s: any) => ({
      step_no: Number(s.step_no),
      text: String(s.text),
      duration_minutes: s.duration_minutes ?? null,
    })),
  };
}

// --- Input cleaning (null = field not provided, [] = provided but empty) ---
type IngredientIn = { name: string; quantity: number | null; unit: string | null; prep_note: string | null; category: string | null };
type StepIn = { text: string; duration_minutes: number | null };

function cleanIngredients(input: unknown): IngredientIn[] | null {
  if (input === undefined) return null;
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 100)
    .map((it: any) => ({
      name: typeof it?.name === "string" ? it.name.trim() : "",
      quantity:
        typeof it?.quantity === "number" && Number.isFinite(it.quantity) && it.quantity > 0
          ? it.quantity
          : null,
      unit: typeof it?.unit === "string" && it.unit.trim() ? it.unit.trim().slice(0, 20) : null,
      prep_note:
        typeof it?.prep_note === "string" && it.prep_note.trim()
          ? it.prep_note.trim().slice(0, 200)
          : null,
      // A category must be one of the Shop's store-order categories;
      // anything else (including a missing one) means "no category" —
      // the ingredient stays uncategorised and its Shop lines land
      // under "Other". A valid category teaches the catalogue (see
      // applyIngredientCategories), it never clears an existing one.
      category: typeof it?.category === "string" && isShopCategory(it.category) ? it.category : null,
    }))
    .filter((it) => it.name.length > 0);
}

function cleanSteps(input: unknown): StepIn[] | null {
  if (input === undefined) return null;
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 100)
    .map((s: any) => ({
      text: typeof s?.text === "string" ? s.text.trim() : typeof s === "string" ? s.trim() : "",
      duration_minutes:
        typeof s?.duration_minutes === "number" &&
        Number.isFinite(s.duration_minutes) &&
        s.duration_minutes > 0
          ? Math.round(s.duration_minutes)
          : null,
    }))
    .filter((s) => s.text.length > 0);
}

// Optional positive integer field: null when absent, undefined when invalid.
function optInt(v: unknown, max: number): number | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) return undefined;
  return Math.round(n);
}

// --- Plan helpers ---
async function weekPlan(k: KitchenEnv, hid: string, weekStart: string): Promise<any | null> {
  return k.DB.prepare("SELECT * FROM cook_week_plans WHERE household_id = ? AND week_start = ?")
    .bind(hid, weekStart)
    .first();
}

async function weekPlanOrCreate(k: KitchenEnv, hid: string, weekStart: string): Promise<any> {
  const existing = await weekPlan(k, hid, weekStart);
  if (existing) return existing;
  const id = uid();
  await k.DB.prepare(
    "INSERT INTO cook_week_plans (id, household_id, week_start, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, hid, weekStart, nowIso())
    .run();
  return { id, household_id: hid, week_start: weekStart };
}

async function weekDays(k: KitchenEnv, planId: string): Promise<any[]> {
  const { results } = await k.DB.prepare(
    "SELECT d.*, r.name AS recipe_name FROM cook_plan_days d " +
      "LEFT JOIN cook_recipes r ON r.id = d.recipe_id WHERE d.plan_id = ? " +
      "ORDER BY d.date, CASE d.meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END",
  )
    .bind(planId)
    .all();
  return results as any[];
}

function dayShape(d: any) {
  return {
    date: String(d.date),
    meal: String(d.meal),
    state: String(d.state),
    recipe_id: d.recipe_id ? String(d.recipe_id) : null,
    recipe_name: d.recipe_name ? String(d.recipe_name) : null,
    servings: d.servings ?? null,
    source_date: d.source_date ? String(d.source_date) : null,
    source_meal: d.source_meal ? String(d.source_meal) : null,
    resolution: d.resolution ? String(d.resolution) : null,
    resolved_by: d.resolved_by ? String(d.resolved_by) : null,
    resolved_at: d.resolved_at ? String(d.resolved_at) : null,
  };
}

// Plan warnings (spec §5, Cook Board §3): informational only, never block.
// - repeat: a recipe planned 2+ times in the week.
// - recent: a recipe planned this week that was cooked in the 7 days
//   before the week started (cooked last week).
function weekWarnings(days: any[], lc: Map<string, Rotation>, monday: Date) {
  const warnings: { type: string; recipe_id: string; recipe_name: string; detail: string }[] = [];
  const byRecipe = new Map<string, { name: string; dates: string[] }>();
  for (const d of days) {
    if (d.state !== "recipe" || !d.recipe_id) continue;
    const e = byRecipe.get(String(d.recipe_id)) || { name: String(d.recipe_name || ""), dates: [] };
    e.dates.push(String(d.date));
    byRecipe.set(String(d.recipe_id), e);
  }
  for (const [id, e] of byRecipe) {
    if (e.dates.length > 1) {
      warnings.push({
        type: "repeat",
        recipe_id: id,
        recipe_name: e.name,
        detail: `Planned ${e.dates.length} times this week`,
      });
    }
  }
  const windowStart = fmtDate(addDays(monday, -7));
  const weekStart = fmtDate(monday);
  for (const [id, rot] of lc) {
    if (!byRecipe.has(id)) continue;
    if (rot.last_cooked && rot.last_cooked >= windowStart && rot.last_cooked < weekStart) {
      warnings.push({
        type: "recent",
        recipe_id: id,
        recipe_name: byRecipe.get(id)!.name,
        detail: `Last cooked ${rot.last_cooked}`,
      });
    }
  }
  return warnings;
}

function requireHousehold(ctx: AuthContext | null): { hid: string; userId: string } | Response {
  if (!ctx || !ctx.household) return err("no_household", 403);
  return { hid: ctx.household.id, userId: ctx.user.id };
}

// --- Recipes ---

async function listRecipes(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (id) {
    const full = await fetchRecipeFull(k, auth.hid, id);
    if (!full) return err("recipe_not_found", 404);
    return json({ ok: true, recipe: full });
  }
  const includeArchived = url.searchParams.get("include_archived") === "1";
  const where = includeArchived ? "" : " AND archived_at IS NULL";
  const [recipesRes, membersRes, eventsRes, ingCountRes, stepCountRes] = await k.DB.batch([
    k.DB.prepare(
      `SELECT * FROM cook_recipes WHERE household_id = ?${where} ORDER BY name`,
    ).bind(auth.hid),
    k.DB.prepare(
      "SELECT u.id AS id, u.name AS name FROM household_members m " +
        "JOIN users u ON u.id = m.user_id WHERE m.household_id = ?",
    ).bind(auth.hid),
    k.DB.prepare(
      "SELECT recipe_id, MAX(date) AS last_cooked, COUNT(*) AS times_cooked " +
        "FROM cook_events WHERE household_id = ? GROUP BY recipe_id",
    ).bind(auth.hid),
    k.DB.prepare(
      "SELECT i.recipe_id AS recipe_id, COUNT(*) AS n FROM cook_recipe_ingredients i " +
        "JOIN cook_recipes r ON r.id = i.recipe_id WHERE r.household_id = ? GROUP BY i.recipe_id",
    ).bind(auth.hid),
    k.DB.prepare(
      "SELECT s.recipe_id AS recipe_id, COUNT(*) AS n FROM cook_recipe_steps s " +
        "JOIN cook_recipes r ON r.id = s.recipe_id WHERE r.household_id = ? GROUP BY s.recipe_id",
    ).bind(auth.hid),
  ]);
  const cooks = new Map<string, string>();
  for (const m of membersRes.results as any[]) cooks.set(String(m.id), String(m.name));
  const lc = new Map<string, Rotation>();
  for (const r of eventsRes.results as any[]) {
    lc.set(String(r.recipe_id), {
      last_cooked: r.last_cooked ? String(r.last_cooked) : null,
      times_cooked: Number(r.times_cooked) || 0,
    });
  }
  const ingCount = new Map<string, number>();
  for (const r of ingCountRes.results as any[]) ingCount.set(String(r.recipe_id), Number(r.n));
  const stepCount = new Map<string, number>();
  for (const r of stepCountRes.results as any[]) stepCount.set(String(r.recipe_id), Number(r.n));
  return json({
    ok: true,
    recipes: (recipesRes.results as any[]).map((r: any) =>
      recipeShape(r, lc, cooks, {
        ingredient_count: ingCount.get(String(r.id)) || 0,
        step_count: stepCount.get(String(r.id)) || 0,
      }),
    ),
  });
}

async function createRecipe(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const body = await readBody(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 200) return err("recipe_name_required", 400);
  const cookMinutes = optInt(body.cook_minutes, 1440);
  if (cookMinutes === undefined) return err("invalid_cook_minutes", 400);
  const servings = optInt(body.servings, 100);
  if (servings === undefined) return err("invalid_servings", 400);
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : "";
  const usualCookId =
    typeof body.usual_cook_id === "string" && body.usual_cook_id ? body.usual_cook_id : null;
  const ingredients = cleanIngredients(body.ingredients) ?? [];
  const steps = cleanSteps(body.steps) ?? [];
  // Member check (when a cook is named) + duplicate-name warning, one batch.
  const stmts: D1PreparedStatement[] = [];
  const cookIdx = usualCookId ? stmts.length : -1;
  if (usualCookId) {
    stmts.push(
      k.DB.prepare("SELECT 1 AS ok FROM household_members WHERE household_id = ? AND user_id = ?").bind(
        auth.hid,
        usualCookId,
      ),
    );
  }
  const dupIdx = stmts.length;
  stmts.push(
    k.DB.prepare(
      "SELECT id FROM cook_recipes WHERE household_id = ? AND LOWER(name) = LOWER(?) AND archived_at IS NULL",
    ).bind(auth.hid, name),
  );
  const checks = await k.DB.batch(stmts);
  if (cookIdx >= 0 && !checks[cookIdx].results[0]) return err("invalid_cook", 400);
  const duplicate = checks[dupIdx].results.length > 0;
  // Canonical items first (two batched round-trips inside resolveItems),
  // then the recipe + its rows in one all-or-nothing batch.
  const itemIds = await resolveItems(k, auth.hid, ingredients.map((i) => i.name));
  const id = uid();
  const now = nowIso();
  const writes: D1PreparedStatement[] = [
    k.DB.prepare(
      "INSERT INTO cook_recipes (id, household_id, name, usual_cook_id, cook_minutes, servings, notes, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, auth.hid, name, usualCookId, cookMinutes, servings, notes, now, now),
  ];
  ingredients.forEach((ing, i) => {
    writes.push(
      k.DB.prepare(
        "INSERT INTO cook_recipe_ingredients (recipe_id, item_id, quantity, unit, prep_note, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, itemIds.get(canonicalName(ing.name))!, ing.quantity, ing.unit, ing.prep_note, i),
    );
  });
  steps.forEach((s, i) => {
    writes.push(
      k.DB.prepare(
        "INSERT INTO cook_recipe_steps (recipe_id, step_no, text, duration_minutes) VALUES (?, ?, ?, ?)",
      ).bind(id, i + 1, s.text, s.duration_minutes),
    );
  });
  await k.DB.batch(writes);
  await applyIngredientCategories(k, itemIds, ingredients);
  const cooks = await memberNames(k, auth.hid);
  return json(
    {
      ok: true,
      recipe: recipeShape(
        {
          id,
          name,
          usual_cook_id: usualCookId,
          cook_minutes: cookMinutes,
          servings,
          notes,
          photo_r2_key: null,
          archived_at: null,
          created_at: now,
        },
        new Map(),
        cooks,
        { ingredient_count: ingredients.length, step_count: steps.length },
      ),
      duplicate_name_warning: duplicate,
    },
    201,
  );
}

async function updateRecipe(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return err("recipe_required", 400);
  const existing: any = await k.DB.prepare(
    "SELECT * FROM cook_recipes WHERE id = ? AND household_id = ?",
  )
    .bind(id, auth.hid)
    .first();
  if (!existing) return err("recipe_not_found", 404);
  const body = await readBody(request);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.name === "string") {
    const n = body.name.trim();
    if (!n || n.length > 200) return err("recipe_name_required", 400);
    sets.push("name = ?");
    binds.push(n);
  }
  let usualCookId: string | null | undefined;
  if (body.usual_cook_id !== undefined) {
    usualCookId =
      typeof body.usual_cook_id === "string" && body.usual_cook_id ? body.usual_cook_id : null;
    sets.push("usual_cook_id = ?");
    binds.push(usualCookId);
  }
  if (body.cook_minutes !== undefined) {
    const v = optInt(body.cook_minutes, 1440);
    if (v === undefined) return err("invalid_cook_minutes", 400);
    sets.push("cook_minutes = ?");
    binds.push(v);
  }
  if (body.servings !== undefined) {
    const v = optInt(body.servings, 100);
    if (v === undefined) return err("invalid_servings", 400);
    sets.push("servings = ?");
    binds.push(v);
  }
  if (typeof body.notes === "string") {
    sets.push("notes = ?");
    binds.push(body.notes.trim().slice(0, 2000));
  }
  const ingredients = cleanIngredients(body.ingredients);
  const steps = cleanSteps(body.steps);
  // Validate the cook (when changed) before writing.
  if (usualCookId) {
    const ok: any = await k.DB.prepare(
      "SELECT 1 AS ok FROM household_members WHERE household_id = ? AND user_id = ?",
    )
      .bind(auth.hid, usualCookId)
      .first();
    if (!ok) return err("invalid_cook", 400);
  }
  // Replace ingredient/step rows when provided (DELETE + INSERT in the
  // same all-or-nothing batch as the recipe update).
  let itemIds = new Map<string, string>();
  if (ingredients !== null) {
    itemIds = await resolveItems(k, auth.hid, ingredients.map((i) => i.name));
  }
  const writes: D1PreparedStatement[] = [];
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    binds.push(nowIso());
    writes.push(
      k.DB.prepare(`UPDATE cook_recipes SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id),
    );
  }
  if (ingredients !== null) {
    writes.push(k.DB.prepare("DELETE FROM cook_recipe_ingredients WHERE recipe_id = ?").bind(id));
    ingredients.forEach((ing, i) => {
      writes.push(
        k.DB.prepare(
          "INSERT INTO cook_recipe_ingredients (recipe_id, item_id, quantity, unit, prep_note, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(id, itemIds.get(canonicalName(ing.name))!, ing.quantity, ing.unit, ing.prep_note, i),
      );
    });
  }
  if (steps !== null) {
    writes.push(k.DB.prepare("DELETE FROM cook_recipe_steps WHERE recipe_id = ?").bind(id));
    steps.forEach((s, i) => {
      writes.push(
        k.DB.prepare(
          "INSERT INTO cook_recipe_steps (recipe_id, step_no, text, duration_minutes) VALUES (?, ?, ?, ?)",
        ).bind(id, i + 1, s.text, s.duration_minutes),
      );
    });
  }
  if (writes.length > 0) await k.DB.batch(writes);
  if (ingredients !== null) await applyIngredientCategories(k, itemIds, ingredients);
  const full = await fetchRecipeFull(k, auth.hid, id);
  return json({ ok: true, recipe: full });
}

async function archiveRecipe(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return err("recipe_required", 400);
  const now = nowIso();
  const meta = await k.DB.prepare(
    "UPDATE cook_recipes SET archived_at = ? WHERE id = ? AND household_id = ? AND archived_at IS NULL",
  )
    .bind(now, id, auth.hid)
    .run();
  if ((meta.meta as any)?.changes === 0) {
    const existing: any = await k.DB.prepare(
      "SELECT id FROM cook_recipes WHERE id = ? AND household_id = ?",
    )
      .bind(id, auth.hid)
      .first();
    if (!existing) return err("recipe_not_found", 404);
  }
  return json({ ok: true, archived_at: now });
}

async function restoreRecipe(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return err("recipe_required", 400);
  const meta = await k.DB.prepare(
    "UPDATE cook_recipes SET archived_at = NULL WHERE id = ? AND household_id = ?",
  )
    .bind(id, auth.hid)
    .run();
  if ((meta.meta as any)?.changes === 0) return err("recipe_not_found", 404);
  const full = await fetchRecipeFull(k, auth.hid, id);
  return json({ ok: true, recipe: full });
}

// --- Plan ---

async function getPlan(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const param = new URL(request.url).searchParams.get("week_start");
  const monday = param ? mondayOf(parseDate(param) ?? new Date()) : mondayOf(new Date());
  if (!param && !monday) return err("invalid_week", 400);
  const weekStart = fmtDate(monday);
  const plan = await weekPlan(k, auth.hid, weekStart);
  const days = plan ? await weekDays(k, String(plan.id)) : [];
  const lc = await lastCookedMap(k, auth.hid);
  return json({
    ok: true,
    week_start: weekStart,
    days: days.map(dayShape),
    warnings: weekWarnings(days, lc, monday),
  });
}

async function setSlot(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const body = await readBody(request);
  const monday = body.week_start ? mondayOf(parseDate(String(body.week_start)) ?? new Date()) : null;
  if (!monday) return err("invalid_week", 400);
  const weekStart = fmtDate(monday);
  const date = parseDate(String(body.date || ""));
  if (!date) return err("invalid_date", 400);
  const dateStr = fmtDate(date);
  if (dateStr < weekStart || dateStr > fmtDate(addDays(monday, 6))) return err("date_outside_week", 400);
  if (!isMeal(body.meal)) return err("invalid_meal", 400);
  const meal = body.meal as Meal;
  const state = body.state;
  if (state !== "recipe" && state !== "eat_out" && state !== "leftovers") {
    return err("invalid_state", 400);
  }
  let recipeId: string | null = null;
  let servings: number | null = null;
  let sourceDate: string | null = null;
  let sourceMeal: Meal | null = null;
  if (state === "recipe") {
    recipeId = typeof body.recipe_id === "string" ? body.recipe_id : "";
    if (!recipeId) return err("recipe_required", 400);
    const r: any = await k.DB.prepare(
      "SELECT id FROM cook_recipes WHERE id = ? AND household_id = ? AND archived_at IS NULL",
    )
      .bind(recipeId, auth.hid)
      .first();
    if (!r) return err("recipe_not_found", 400);
    const s = optInt(body.servings, 100);
    if (s === undefined) return err("invalid_servings", 400);
    servings = s;
  } else if (state === "leftovers") {
    const sd = parseDate(String(body.source_date || ""));
    if (!sd || !isMeal(body.source_meal)) return err("invalid_leftover_source", 400);
    sourceDate = fmtDate(sd);
    sourceMeal = body.source_meal as Meal;
    if (!slotBefore(sourceDate, sourceMeal, dateStr, meal)) return err("invalid_leftover_source", 400);
    const srcPlan = await weekPlan(k, auth.hid, fmtDate(mondayOf(sd)));
    let src: any = null;
    if (srcPlan) {
      src = await k.DB.prepare(
        "SELECT * FROM cook_plan_days WHERE plan_id = ? AND date = ? AND meal = ? AND state = 'recipe' AND recipe_id IS NOT NULL",
      )
        .bind(String(srcPlan.id), sourceDate, sourceMeal)
        .first();
    }
    if (!src) return err("invalid_leftover_source", 400);
  }
  const plan = await weekPlanOrCreate(k, auth.hid, weekStart);
  // Setting a slot resets its resolution: a re-planned slot is unrecorded.
  // A cook event from an earlier resolution stays — history is truthful.
  await k.DB.prepare(
    "INSERT INTO cook_plan_days (plan_id, date, meal, state, recipe_id, servings, source_date, source_meal, resolution, resolved_by, resolved_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL) " +
      "ON CONFLICT(plan_id, date, meal) DO UPDATE SET state = excluded.state, recipe_id = excluded.recipe_id, " +
      "servings = excluded.servings, source_date = excluded.source_date, source_meal = excluded.source_meal, " +
      "resolution = NULL, resolved_by = NULL, resolved_at = NULL",
  )
    .bind(String(plan.id), dateStr, meal, state, recipeId, servings, sourceDate, sourceMeal)
    .run();
  return json({
    ok: true,
    slot: {
      date: dateStr,
      meal,
      state,
      recipe_id: recipeId,
      servings,
      source_date: sourceDate,
      source_meal: sourceMeal,
      resolution: null,
    },
  });
}

async function clearSlot(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const q = new URL(request.url).searchParams;
  const monday = q.get("week_start") ? mondayOf(parseDate(q.get("week_start")!) ?? new Date()) : null;
  if (!monday) return err("invalid_week", 400);
  const date = parseDate(q.get("date") || "");
  if (!date || !isMeal(q.get("meal"))) return err("invalid_slot", 400);
  const plan = await weekPlan(k, auth.hid, fmtDate(monday));
  if (!plan) return json({ ok: true, deleted: false });
  const meta = await k.DB.prepare("DELETE FROM cook_plan_days WHERE plan_id = ? AND date = ? AND meal = ?")
    .bind(String(plan.id), fmtDate(date), q.get("meal"))
    .run();
  return json({ ok: true, deleted: ((meta.meta as any)?.changes ?? 0) > 0 });
}

async function copyForward(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const body = await readBody(request);
  const fromDate = parseDate(String(body.from_week_start || ""));
  if (!fromDate) return err("invalid_week", 400);
  const fromMonday = mondayOf(fromDate);
  const targetMonday = addDays(fromMonday, 7);
  const fromPlan = await weekPlan(k, auth.hid, fmtDate(fromMonday));
  const targetWeekStart = fmtDate(targetMonday);
  if (!fromPlan) return json({ ok: true, copied: 0, skipped: 0, target_week_start: targetWeekStart });
  const fromDays = await weekDays(k, String(fromPlan.id));
  const toPlan = await weekPlanOrCreate(k, auth.hid, targetWeekStart);
  const toDays = await weekDays(k, String(toPlan.id));
  const existing = new Set(toDays.map((d: any) => `${String(d.date)}|${String(d.meal)}`));
  const inserts: D1PreparedStatement[] = [];
  let copied = 0;
  let skipped = 0;
  for (const d of fromDays) {
    const targetDate = fmtDate(addDays(parseDate(String(d.date))!, 7));
    if (existing.has(`${targetDate}|${String(d.meal)}`)) {
      skipped++;
      continue;
    }
    // A leftover source moves with the week, so the link stays in-week.
    const srcDate = d.source_date ? fmtDate(addDays(parseDate(String(d.source_date))!, 7)) : null;
    inserts.push(
      k.DB.prepare(
        "INSERT INTO cook_plan_days (plan_id, date, meal, state, recipe_id, servings, source_date, source_meal, resolution, resolved_by, resolved_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
      ).bind(
        String(toPlan.id),
        targetDate,
        String(d.meal),
        String(d.state),
        d.recipe_id ? String(d.recipe_id) : null,
        d.servings ?? null,
        srcDate,
        d.source_meal ? String(d.source_meal) : null,
      ),
    );
    copied++;
  }
  if (inserts.length > 0) await k.DB.batch(inserts);
  return json({ ok: true, copied, skipped, target_week_start: targetWeekStart });
}

async function resolveSlot(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const body = await readBody(request);
  const monday = body.week_start ? mondayOf(parseDate(String(body.week_start)) ?? new Date()) : null;
  if (!monday) return err("invalid_week", 400);
  const date = parseDate(String(body.date || ""));
  if (!date || !isMeal(body.meal)) return err("invalid_slot", 400);
  const dateStr = fmtDate(date);
  const meal = body.meal as Meal;
  // resolution null clears the resolution (un-resolve).
  const resolution = body.resolution === null ? null : body.resolution;
  if (resolution !== null && !(RESOLUTIONS as readonly string[]).includes(resolution)) {
    return err("invalid_resolution", 400);
  }
  const rating =
    typeof body.rating === "number" && (body.rating === 1 || body.rating === -1) ? body.rating : null;
  const plan = await weekPlan(k, auth.hid, fmtDate(monday));
  if (!plan) return err("slot_not_found", 404);
  const day: any = await k.DB.prepare(
    "SELECT * FROM cook_plan_days WHERE plan_id = ? AND date = ? AND meal = ?",
  )
    .bind(String(plan.id), dateStr, meal)
    .first();
  if (!day) return err("slot_not_found", 404);
  if (day.state !== "recipe" || !day.recipe_id) return err("not_a_recipe_slot", 400);
  const recipeId = String(day.recipe_id);
  const prevResolution = day.resolution ? String(day.resolution) : null;
  // Optional leftovers shortcut (Cook Board §8): with a Cooked resolution,
  // set a following slot to Leftovers from this recipe. Validate it first.
  let leftoverPlan: any = null;
  let leftoverDateStr: string | null = null;
  let leftoverMeal: Meal | null = null;
  if (resolution === "cooked" && body.leftover_slot) {
    const ls = body.leftover_slot;
    const lsDate = parseDate(String(ls.date || ""));
    if (!lsDate || !isMeal(ls.meal)) return err("invalid_leftover_slot", 400);
    leftoverDateStr = fmtDate(lsDate);
    leftoverMeal = ls.meal as Meal;
    if (!slotBefore(dateStr, meal, leftoverDateStr, leftoverMeal)) {
      return err("invalid_leftover_slot", 400);
    }
    leftoverPlan = await weekPlanOrCreate(k, auth.hid, fmtDate(mondayOf(lsDate)));
    const taken: any = await k.DB.prepare(
      "SELECT 1 AS ok FROM cook_plan_days WHERE plan_id = ? AND date = ? AND meal = ?",
    )
      .bind(String(leftoverPlan.id), leftoverDateStr, leftoverMeal)
      .first();
    if (taken) return err("leftover_slot_taken", 400);
  }
  // The cook event for this slot, if one exists.
  const ev: any = await k.DB.prepare(
    "SELECT id FROM cook_events WHERE household_id = ? AND recipe_id = ? AND date = ? AND meal = ?",
  )
    .bind(auth.hid, recipeId, dateStr, meal)
    .first();
  const now = nowIso();
  const writes: D1PreparedStatement[] = [];
  if (resolution === "cooked") {
    if (ev) {
      if (rating !== null) {
        writes.push(
          k.DB.prepare("UPDATE cook_events SET rating = ? WHERE id = ?").bind(rating, String(ev.id)),
        );
      }
    } else {
      writes.push(
        k.DB.prepare(
          "INSERT INTO cook_events (id, household_id, recipe_id, date, meal, cooked_by, rating, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(uid(), auth.hid, recipeId, dateStr, meal, auth.userId, rating, now),
      );
    }
  } else if (prevResolution === "cooked" && ev) {
    // Re-resolving away from Cooked removes the event, so last-cooked
    // stays truthful (events are insert-only in normal use; a correction
    // is the one exception).
    writes.push(k.DB.prepare("DELETE FROM cook_events WHERE id = ?").bind(String(ev.id)));
  }
  writes.push(
    k.DB.prepare(
      "UPDATE cook_plan_days SET resolution = ?, resolved_by = ?, resolved_at = ? WHERE plan_id = ? AND date = ? AND meal = ?",
    ).bind(resolution, resolution === null ? null : auth.userId, resolution === null ? null : now, String(plan.id), dateStr, meal),
  );
  if (leftoverPlan && leftoverDateStr && leftoverMeal) {
    writes.push(
      k.DB.prepare(
        "INSERT INTO cook_plan_days (plan_id, date, meal, state, recipe_id, servings, source_date, source_meal, resolution, resolved_by, resolved_at) " +
          "VALUES (?, ?, ?, 'leftovers', NULL, NULL, ?, ?, NULL, NULL, NULL)",
      ).bind(String(leftoverPlan.id), leftoverDateStr, leftoverMeal, dateStr, meal),
    );
  }
  await k.DB.batch(writes);
  const lc: any = await k.DB.prepare(
    "SELECT MAX(date) AS last_cooked FROM cook_events WHERE household_id = ? AND recipe_id = ?",
  )
    .bind(auth.hid, recipeId)
    .first();
  return json({
    ok: true,
    resolution,
    last_cooked: lc?.last_cooked ? String(lc.last_cooked) : null,
  });
}

async function cookSomethingElse(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const body = await readBody(request);
  const monday = body.week_start ? mondayOf(parseDate(String(body.week_start)) ?? new Date()) : null;
  if (!monday) return err("invalid_week", 400);
  const weekStart = fmtDate(monday);
  const date = parseDate(String(body.date || ""));
  if (!date || !isMeal(body.meal)) return err("invalid_slot", 400);
  const dateStr = fmtDate(date);
  const meal = body.meal as Meal;
  const mode = body.mode;
  if (mode !== "swap" && mode !== "library" && mode !== "new") return err("invalid_mode", 400);
  const plan = await weekPlan(k, auth.hid, weekStart);
  if (!plan) return err("slot_not_found", 404);
  const day: any = await k.DB.prepare(
    "SELECT * FROM cook_plan_days WHERE plan_id = ? AND date = ? AND meal = ?",
  )
    .bind(String(plan.id), dateStr, meal)
    .first();
  if (!day || day.state !== "recipe" || !day.recipe_id) return err("no_planned_recipe", 400);
  if (day.resolution) return err("slot_resolved", 400);
  const currentRecipeId = String(day.recipe_id);

  if (mode === "swap") {
    const tDate = parseDate(String(body.target_date || ""));
    if (!tDate || !isMeal(body.target_meal)) return err("invalid_swap_target", 400);
    const tDateStr = fmtDate(tDate);
    const tMeal = body.target_meal as Meal;
    if (tDateStr === dateStr && tMeal === meal) return err("invalid_swap_target", 400);
    const tPlan = await weekPlan(k, auth.hid, fmtDate(mondayOf(tDate)));
    let target: any = null;
    if (tPlan) {
      target = await k.DB.prepare(
        "SELECT * FROM cook_plan_days WHERE plan_id = ? AND date = ? AND meal = ?",
      )
        .bind(String(tPlan.id), tDateStr, tMeal)
        .first();
    }
    if (!target || target.state !== "recipe" || !target.recipe_id) {
      return err("invalid_swap_target", 400);
    }
    if (target.resolution) return err("slot_resolved", 400);
    // Servings stay with the slot (the headcount does not change because
    // the dish did); only the recipes move.
    await k.DB.batch([
      k.DB.prepare(
        "UPDATE cook_plan_days SET recipe_id = ?, resolution = NULL, resolved_by = NULL, resolved_at = NULL WHERE plan_id = ? AND date = ? AND meal = ?",
      ).bind(String(target.recipe_id), String(plan.id), dateStr, meal),
      k.DB.prepare(
        "UPDATE cook_plan_days SET recipe_id = ?, resolution = NULL, resolved_by = NULL, resolved_at = NULL WHERE plan_id = ? AND date = ? AND meal = ?",
      ).bind(currentRecipeId, String(tPlan.id), tDateStr, tMeal),
    ]);
    return json({
      ok: true,
      mode: "swap",
      slots: [
        { date: dateStr, meal, recipe_id: String(target.recipe_id) },
        { date: tDateStr, meal: tMeal, recipe_id: currentRecipeId },
      ],
    });
  }

  if (mode === "library") {
    const recipeId = typeof body.recipe_id === "string" ? body.recipe_id : "";
    if (!recipeId) return err("recipe_required", 400);
    const r: any = await k.DB.prepare(
      "SELECT id FROM cook_recipes WHERE id = ? AND household_id = ? AND archived_at IS NULL",
    )
      .bind(recipeId, auth.hid)
      .first();
    if (!r) return err("recipe_not_found", 400);
    // The library pick must not already be planned this week (spec §6) —
    // direct planning allows repeats with a warning, this path does not.
    const planned: any = await k.DB.prepare(
      "SELECT 1 AS ok FROM cook_plan_days d JOIN cook_week_plans p ON p.id = d.plan_id " +
        "WHERE p.household_id = ? AND p.week_start = ? AND d.recipe_id = ?",
    )
      .bind(auth.hid, weekStart, recipeId)
      .first();
    if (planned) return err("already_planned_this_week", 400);
    await k.DB.prepare(
      "UPDATE cook_plan_days SET recipe_id = ?, resolution = NULL, resolved_by = NULL, resolved_at = NULL WHERE plan_id = ? AND date = ? AND meal = ?",
    )
      .bind(recipeId, String(plan.id), dateStr, meal)
      .run();
    const full = await fetchRecipeFull(k, auth.hid, recipeId);
    return json({ ok: true, mode: "library", recipe: full });
  }

  // mode === "new": a name-only recipe, created now; this meal is its
  // first plan (spec §6). Ingredients and instructions can be added later.
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 200) return err("recipe_name_required", 400);
  const dup: any = await k.DB.prepare(
    "SELECT id FROM cook_recipes WHERE household_id = ? AND LOWER(name) = LOWER(?) AND archived_at IS NULL",
  )
    .bind(auth.hid, name)
    .first();
  const id = uid();
  const now = nowIso();
  await k.DB.batch([
    k.DB.prepare(
      "INSERT INTO cook_recipes (id, household_id, name, notes, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)",
    ).bind(id, auth.hid, name, now, now),
    k.DB.prepare(
      "UPDATE cook_plan_days SET recipe_id = ?, resolution = NULL, resolved_by = NULL, resolved_at = NULL WHERE plan_id = ? AND date = ? AND meal = ?",
    ).bind(id, String(plan.id), dateStr, meal),
  ]);
  const full = await fetchRecipeFull(k, auth.hid, id);
  return json({ ok: true, mode: "new", recipe: full, duplicate_name_warning: Boolean(dup) });
}

// --- Today + next meal ---

async function getToday(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const param = new URL(request.url).searchParams.get("date");
  const today = param ? parseDate(param) : new Date();
  if (!today) return err("invalid_date", 400);
  const todayStr = fmtDate(today);
  const monday = mondayOf(today);
  const weekStart = fmtDate(monday);
  const plan = await weekPlan(k, auth.hid, weekStart);
  const days = plan ? await weekDays(k, String(plan.id)) : [];
  const todays = days.filter((d: any) => String(d.date) === todayStr);
  // Unresolved past recipe slots in this week (Mon..yesterday).
  const unresolved = days
    .filter((d: any) => String(d.date) < todayStr && d.state === "recipe" && !d.resolution)
    .map((d: any) => ({
      week_start: weekStart,
      date: String(d.date),
      meal: String(d.meal),
      recipe_id: String(d.recipe_id),
      recipe_name: d.recipe_name ? String(d.recipe_name) : null,
    }));
  // Full recipe detail for today's recipe meals, one batched round-trip.
  const recipeIds = [...new Set(todays.filter((d: any) => d.state === "recipe" && d.recipe_id).map((d: any) => String(d.recipe_id)))];
  const details = new Map<string, any>();
  if (recipeIds.length > 0) {
    const placeholders = recipeIds.map(() => "?").join(",");
    const [recipesRes, ingRes, stepRes, evRes, membersRes] = await k.DB.batch([
      k.DB.prepare(`SELECT * FROM cook_recipes WHERE id IN (${placeholders})`).bind(...recipeIds),
      k.DB.prepare(
        `SELECT i.*, s.canonical_name AS item_name FROM cook_recipe_ingredients i JOIN shop_items s ON s.id = i.item_id WHERE i.recipe_id IN (${placeholders}) ORDER BY i.recipe_id, i.sort_order`,
      ).bind(...recipeIds),
      k.DB.prepare(
        `SELECT * FROM cook_recipe_steps WHERE recipe_id IN (${placeholders}) ORDER BY recipe_id, step_no`,
      ).bind(...recipeIds),
      k.DB.prepare(
        `SELECT recipe_id, MAX(date) AS last_cooked, COUNT(*) AS times_cooked FROM cook_events WHERE recipe_id IN (${placeholders}) AND household_id = ? GROUP BY recipe_id`,
      ).bind(...recipeIds, auth.hid),
      k.DB.prepare(
        "SELECT u.id AS id, u.name AS name FROM household_members m " +
          "JOIN users u ON u.id = m.user_id WHERE m.household_id = ?",
      ).bind(auth.hid),
    ]);
    const cooks = new Map<string, string>();
    for (const m of membersRes.results as any[]) cooks.set(String(m.id), String(m.name));
    const lc = new Map<string, Rotation>();
    for (const r of evRes.results as any[]) {
      lc.set(String(r.recipe_id), {
        last_cooked: r.last_cooked ? String(r.last_cooked) : null,
        times_cooked: Number(r.times_cooked) || 0,
      });
    }
    const ings = new Map<string, any[]>();
    for (const i of ingRes.results as any[]) {
      const arr = ings.get(String(i.recipe_id)) || [];
      arr.push({
        item_id: String(i.item_id),
        name: String(i.item_name),
        quantity: i.quantity ?? null,
        unit: i.unit ?? null,
        prep_note: i.prep_note ?? null,
        sort_order: Number(i.sort_order),
      });
      ings.set(String(i.recipe_id), arr);
    }
    const steps = new Map<string, any[]>();
    for (const s of stepRes.results as any[]) {
      const arr = steps.get(String(s.recipe_id)) || [];
      arr.push({
        step_no: Number(s.step_no),
        text: String(s.text),
        duration_minutes: s.duration_minutes ?? null,
      });
      steps.set(String(s.recipe_id), arr);
    }
    for (const r of recipesRes.results as any[]) {
      details.set(String(r.id), {
        ...recipeShape(r, lc, cooks),
        ingredients: ings.get(String(r.id)) || [],
        steps: steps.get(String(r.id)) || [],
      });
    }
  }
  // Leftovers slots name their source recipe from the week's days.
  const bySlot = new Map(days.map((d: any) => [`${String(d.date)}|${String(d.meal)}`, d]));
  const meals = todays.map((d: any) => {
    const base = dayShape(d);
    const src = d.source_date && d.source_meal ? bySlot.get(`${String(d.source_date)}|${String(d.source_meal)}`) : null;
    return {
      ...base,
      source_recipe_name: src?.recipe_name ? String(src.recipe_name) : null,
      recipe: d.recipe_id ? details.get(String(d.recipe_id)) || null : null,
    };
  });
  return json({ ok: true, date: todayStr, week_start: weekStart, meals, unresolved });
}

async function getNextMeal(_request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const todayStr = fmtDate(new Date());
  const row: any = await k.DB.prepare(
    "SELECT d.date AS date, d.meal AS meal, r.name AS recipe_name, r.cook_minutes AS cook_minutes " +
      "FROM cook_plan_days d JOIN cook_week_plans p ON p.id = d.plan_id " +
      "JOIN cook_recipes r ON r.id = d.recipe_id " +
      "WHERE p.household_id = ? AND d.state = 'recipe' AND d.resolution IS NULL AND d.date >= ? " +
      "ORDER BY d.date, CASE d.meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END LIMIT 1",
  )
    .bind(auth.hid, todayStr)
    .first();
  if (!row) return json({ ok: true, next: null });
  return json({
    ok: true,
    next: {
      date: String(row.date),
      meal: String(row.meal),
      recipe_name: String(row.recipe_name),
      cook_minutes: row.cook_minutes ?? null,
    },
  });
}

// --- Shop + Pantry (Batch 4) ---
//
// One unified shopping list per week, grouped by grocery category in
// store order (Haven §7). The list is derived from the week's plan at
// generation time only (Option A scaling, Cook Board §5): quantity x
// meal servings / recipe servings; a recipe with no servings recorded
// is not scaled; Eat out / Leftovers slots contribute nothing.
// Countable items round UP to whole AFTER aggregation (two recipes each
// contributing 1.5 eggs aggregate to 3.0, unflagged — rounding is never
// per-ingredient); weights/volumes keep the scaled value. Any rounded
// line is flagged with its unrounded value.
//
// The specs never define "countable", so the classification is a
// documented judgment call: a unit is weight/volume iff, lowercased and
// trimmed, it is in WEIGHT_VOLUME_UNITS; everything else (pcs, piece,
// whole, each, pack, bunch, null/empty unit, ...) is countable.
//
// Pantry is manual Have/Out only, no quantities, no auto-deduction.
// Have fully covers an item (boolean pantry: no partial coverage), so
// its plan lines are dropped at generation; Out puts the item back on
// the list. There is no standing-items source: the Haven spec has no
// standing-items list and its source enum has no 'standing' value.
//
// Finish run is the ONLY thing that creates purchases
// (checked-but-not-bought, Cook Board §6): a checked line becomes a
// purchase, a to-buy line never does, and to-buy lines flagged at
// finish are carried into the next run's generation, otherwise archived
// with the run as not bought.

const SHOP_CATEGORIES = ["Produce", "Meat and seafood", "Dairy and chilled", "Pantry and dry"] as const;
type ShopCategory = (typeof SHOP_CATEGORIES)[number];

function categoryRank(category: string | null): number {
  const i = (SHOP_CATEGORIES as readonly string[]).indexOf(category || "");
  return i === -1 ? SHOP_CATEGORIES.length : i;
}
function isShopCategory(v: unknown): v is ShopCategory {
  return typeof v === "string" && (SHOP_CATEGORIES as readonly string[]).includes(v);
}

// Weight/volume units (lowercased, trimmed). Everything else counts.
const WEIGHT_VOLUME_UNITS = new Set([
  "g", "kg", "mg", "ml", "l", "litre", "litres", "liter", "liters", "dl", "cl",
  "cup", "cups", "tbsp", "tsp", "tablespoon", "tablespoons", "teaspoon", "teaspoons",
  "oz", "lb", "fl oz",
]);
function isCountableUnit(unit: string | null): boolean {
  if (!unit) return true;
  return !WEIGHT_VOLUME_UNITS.has(unit.trim().toLowerCase());
}
// Float noise (0.1 + 0.2) must not flag a whole quantity as fractional.
function isWholeQty(q: number): boolean {
  return Math.abs(q - Math.round(q)) < 1e-9;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function cleanQty(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}
function cleanUnit(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 20) : null;
}

type DerivedLine = {
  item_id: string;
  display_name: string;
  quantity: number | null;
  unit: string | null;
  is_rounded: number;
  unrounded_quantity: number | null;
  category: string | null;
  source: string;
  source_recipe_id: string | null;
  source_date: string | null;
  sources: { recipe_id: string; name: string; date: string; meal: string }[];
};

type DeriveResult = {
  lines: DerivedLine[];
  noIngredientRecipes: { recipe_id: string; name: string; date: string; meal: string }[];
  fingerprint: string;
  planId: string | null;
  carryOverSourceIds: string[];
};

// The plan fingerprint: the week's sorted slot tuples. List edits never
// affect it, so they never trigger the "plan changed" banner.
function planFingerprint(days: any[]): string {
  const tuples = days
    .map((d: any) => [
      String(d.date),
      String(d.meal),
      String(d.state),
      d.recipe_id ? String(d.recipe_id) : null,
      d.servings ?? null,
      d.source_date ? String(d.source_date) : null,
      d.source_meal ? String(d.source_meal) : null,
    ])
    .sort((a: any, b: any) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : mealRank(a[1]) - mealRank(b[1]),
    );
  return JSON.stringify(tuples);
}

// Derive the week's shop lines from the plan + pantry + carry-over.
// Pure read (no writes); the caller inserts the lines and, for
// carry-over, clears the consumed flags in the same batch.
async function deriveFromPlan(k: KitchenEnv, hid: string, weekStart: string): Promise<DeriveResult> {
  const plan = await weekPlan(k, hid, weekStart);
  const days = plan ? await weekDays(k, String(plan.id)) : [];
  const fingerprint = planFingerprint(days);
  const recipeSlots = days.filter((d: any) => d.state === "recipe" && d.recipe_id);
  const recipeIds = [...new Set(recipeSlots.map((d: any) => String(d.recipe_id)))];
  const noIngredientRecipes: DeriveResult["noIngredientRecipes"] = [];

  const stmts: D1PreparedStatement[] = [];
  if (recipeIds.length > 0) {
    const ph = recipeIds.map(() => "?").join(",");
    stmts.push(
      k.DB.prepare(`SELECT id, name, servings FROM cook_recipes WHERE id IN (${ph})`).bind(...recipeIds),
      k.DB.prepare(
        `SELECT i.recipe_id AS recipe_id, i.item_id AS item_id, i.quantity AS quantity, i.unit AS unit, ` +
          `s.canonical_name AS item_name, s.category AS category ` +
          `FROM cook_recipe_ingredients i JOIN shop_items s ON s.id = i.item_id ` +
          `WHERE i.recipe_id IN (${ph}) ORDER BY i.recipe_id, i.sort_order`,
      ).bind(...recipeIds),
    );
  }
  const pantryIdx = stmts.length;
  stmts.push(
    k.DB.prepare(
      "SELECT p.item_id AS item_id, p.on_hand AS on_hand, s.canonical_name AS name, " +
        "s.category AS category, s.default_unit AS default_unit " +
        "FROM shop_pantry_items p JOIN shop_items s ON s.id = p.item_id WHERE p.household_id = ?",
    ).bind(hid),
  );
  const carryIdx = stmts.length;
  stmts.push(
    k.DB.prepare(
      "SELECT l.* FROM shop_list_items l WHERE l.carry_over = 1 AND l.run_id = (" +
        "SELECT id FROM shop_runs WHERE household_id = ? AND status = 'finished' " +
        "ORDER BY finished_at DESC, created_at DESC LIMIT 1)",
    ).bind(hid),
  );
  const results = await k.DB.batch(stmts);
  const recipesRes = recipeIds.length > 0 ? results[0] : null;
  const ingRes = recipeIds.length > 0 ? results[1] : null;
  const pantryRes = results[pantryIdx];
  const carryRes = results[carryIdx];

  const recipes = new Map<string, { name: string; servings: number | null }>();
  for (const r of (recipesRes?.results || []) as any[]) {
    recipes.set(String(r.id), { name: String(r.name), servings: r.servings ?? null });
  }
  const ingsByRecipe = new Map<string, any[]>();
  for (const i of (ingRes?.results || []) as any[]) {
    const arr = ingsByRecipe.get(String(i.recipe_id)) || [];
    arr.push(i);
    ingsByRecipe.set(String(i.recipe_id), arr);
  }
  for (const slot of recipeSlots) {
    if ((ingsByRecipe.get(String(slot.recipe_id)) || []).length === 0) {
      const r = recipes.get(String(slot.recipe_id));
      noIngredientRecipes.push({
        recipe_id: String(slot.recipe_id),
        name: r ? r.name : String(slot.recipe_name || ""),
        date: String(slot.date),
        meal: String(slot.meal),
      });
    }
  }

  // Aggregate by (item_id, unit): same item sums when units match, a
  // unit mismatch keeps two lines. Sources list one entry per
  // contributing SLOT (two slots of the same recipe list twice).
  const agg = new Map<string, {
    item_id: string;
    display_name: string;
    unit: string | null;
    category: string | null;
    total: number;
    hasQty: boolean;
    sources: DerivedLine["sources"];
    seenSlots: Set<string>;
  }>();
  for (const slot of recipeSlots) {
    const recipe = recipes.get(String(slot.recipe_id));
    if (!recipe) continue;
    const mealServings = slot.servings ?? recipe.servings;
    const factor =
      mealServings != null && recipe.servings != null && recipe.servings > 0
        ? mealServings / recipe.servings
        : 1;
    for (const ing of ingsByRecipe.get(String(slot.recipe_id)) || []) {
      const unit = cleanUnit(ing.unit);
      const key = `${String(ing.item_id)}|${unit ?? ""}`;
      let e = agg.get(key);
      if (!e) {
        e = {
          item_id: String(ing.item_id),
          display_name: String(ing.item_name),
          unit,
          category: ing.category ? String(ing.category) : null,
          total: 0,
          hasQty: false,
          sources: [],
          seenSlots: new Set(),
        };
        agg.set(key, e);
      }
      if (typeof ing.quantity === "number" && Number.isFinite(ing.quantity)) {
        e.total += ing.quantity * factor;
        e.hasQty = true;
      }
      const slotKey = `${String(slot.date)}|${String(slot.meal)}|${String(slot.recipe_id)}`;
      if (!e.seenSlots.has(slotKey)) {
        e.seenSlots.add(slotKey);
        e.sources.push({
          recipe_id: String(slot.recipe_id),
          name: recipe.name,
          date: String(slot.date),
          meal: String(slot.meal),
        });
      }
    }
  }

  // Pantry: Have fully covers an item (boolean pantry, no partial
  // coverage); Out items are appended below unless already on the list.
  const pantryHave = new Set<string>();
  const pantryOut: { item_id: string; name: string; category: string | null; default_unit: string | null }[] = [];
  for (const p of pantryRes.results as any[]) {
    if (String(p.on_hand) === "have") pantryHave.add(String(p.item_id));
    else if (String(p.on_hand) === "out") {
      pantryOut.push({
        item_id: String(p.item_id),
        name: String(p.name),
        category: p.category ? String(p.category) : null,
        default_unit: p.default_unit ? String(p.default_unit) : null,
      });
    }
  }

  const lines: DerivedLine[] = [];
  for (const e of agg.values()) {
    if (pantryHave.has(e.item_id)) continue;
    let quantity: number | null = e.hasQty ? e.total : null;
    let isRounded = 0;
    let unrounded: number | null = null;
    if (quantity !== null && !isWholeQty(quantity) && isCountableUnit(e.unit)) {
      unrounded = quantity;
      quantity = Math.ceil(quantity - 1e-9);
      isRounded = 1;
    }
    lines.push({
      item_id: e.item_id,
      display_name: e.display_name,
      quantity,
      unit: e.unit,
      is_rounded: isRounded,
      unrounded_quantity: unrounded,
      category: e.category,
      source: "plan",
      source_recipe_id: e.sources[0]?.recipe_id ?? null,
      source_date: e.sources[0]?.date ?? null,
      sources: e.sources,
    });
  }
  const onList = new Set(lines.map((l) => l.item_id));
  for (const p of pantryOut) {
    if (onList.has(p.item_id)) continue; // already on the list via its plan line
    lines.push({
      item_id: p.item_id,
      display_name: p.name,
      quantity: null,
      unit: p.default_unit,
      is_rounded: 0,
      unrounded_quantity: null,
      category: p.category,
      source: "pantry_out",
      source_recipe_id: null,
      source_date: null,
      sources: [],
    });
  }

  // Carry-over from the latest finished run: appended as their own
  // lines (same item/qty/unit); the caller clears the consumed flags
  // in the same batch as the insert, so a regenerate cannot re-append
  // them. A carry-over line is NOT merged into a plan line for the same
  // item — each keeps its own provenance.
  const carryOverSourceIds: string[] = [];
  for (const l of carryRes.results as any[]) {
    carryOverSourceIds.push(String(l.id));
    lines.push({
      item_id: String(l.item_id),
      display_name: String(l.display_name),
      quantity: l.quantity ?? null,
      unit: l.unit ?? null,
      is_rounded: 0,
      unrounded_quantity: null,
      category: l.category ? String(l.category) : null,
      source: "carry_over",
      source_recipe_id: l.source_recipe_id ? String(l.source_recipe_id) : null,
      source_date: l.source_date ? String(l.source_date) : null,
      sources: parseSources(l.sources),
    });
  }

  return {
    lines,
    noIngredientRecipes,
    fingerprint,
    planId: plan ? String(plan.id) : null,
    carryOverSourceIds,
  };
}

function parseSources(raw: unknown): DerivedLine["sources"] {
  if (!raw) return [];
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// --- Shop helpers ---

async function activeRun(k: KitchenEnv, hid: string): Promise<any | null> {
  return k.DB.prepare(
    "SELECT * FROM shop_runs WHERE household_id = ? AND status IN ('draft', 'shopping') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(hid)
    .first();
}

// The run for a week: the active run when it is that week, else the
// latest finished run for the week (or null).
async function runForWeek(k: KitchenEnv, hid: string, weekStart: string): Promise<any | null> {
  const active = await activeRun(k, hid);
  if (active && String(active.week_start) === weekStart) return active;
  return k.DB.prepare(
    "SELECT * FROM shop_runs WHERE household_id = ? AND week_start = ? AND status = 'finished' ORDER BY finished_at DESC, created_at DESC LIMIT 1",
  )
    .bind(hid, weekStart)
    .first();
}

// Most recent purchase per item (household-scoped via the run). Runs
// are few and purchases fewer, so one ordered read + first-seen in JS.
async function lastBoughtMap(k: KitchenEnv, hid: string): Promise<Map<string, { date: string; unit_price: number | null }>> {
  const { results } = await k.DB.prepare(
    "SELECT p.item_id AS item_id, p.bought_date AS bought_date, p.unit_price AS unit_price " +
      "FROM shop_purchases p JOIN shop_runs r ON r.id = p.run_id " +
      "WHERE r.household_id = ? ORDER BY p.bought_date DESC, p.created_at DESC",
  )
    .bind(hid)
    .all();
  const map = new Map<string, { date: string; unit_price: number | null }>();
  for (const p of results as any[]) {
    const id = String(p.item_id);
    if (!map.has(id)) {
      map.set(id, { date: String(p.bought_date), unit_price: p.unit_price ?? null });
    }
  }
  return map;
}

function runShape(r: any) {
  return {
    id: String(r.id),
    week_start: String(r.week_start),
    store: r.store ? String(r.store) : null,
    run_date: r.run_date ? String(r.run_date) : null,
    status: String(r.status),
    created_by: String(r.created_by),
    created_at: String(r.created_at),
    finished_at: r.finished_at ? String(r.finished_at) : null,
  };
}

function lineShape(l: any, lastBought: Map<string, { date: string; unit_price: number | null }>) {
  const lb = l.item_id ? lastBought.get(String(l.item_id)) : undefined;
  return {
    id: String(l.id),
    item_id: l.item_id ? String(l.item_id) : null,
    display_name: String(l.display_name),
    quantity: l.quantity ?? null,
    unit: l.unit ?? null,
    is_rounded: Number(l.is_rounded) === 1,
    unrounded_quantity: l.unrounded_quantity ?? null,
    category: l.category ? String(l.category) : null,
    state: String(l.state),
    source: String(l.source),
    source_recipe_id: l.source_recipe_id ? String(l.source_recipe_id) : null,
    source_date: l.source_date ? String(l.source_date) : null,
    sources: parseSources(l.sources),
    carry_over: Number(l.carry_over) === 1,
    last_bought_date: lb?.date ?? null,
    last_unit_price: lb?.unit_price ?? null,
  };
}

async function shopLinesForRun(k: KitchenEnv, runId: string): Promise<any[]> {
  const { results } = await k.DB.prepare(
    "SELECT * FROM shop_list_items WHERE run_id = ? ORDER BY " +
      "CASE category WHEN 'Produce' THEN 0 WHEN 'Meat and seafood' THEN 1 " +
      "WHEN 'Dairy and chilled' THEN 2 WHEN 'Pantry and dry' THEN 3 ELSE 4 END, display_name",
  )
    .bind(runId)
    .all();
  return results as any[];
}

// Resolve a manual-add target to a canonical shop_items row. item_id
// must belong to the household; a name resolves (creating the item when
// missing, via resolveItems). Returns the row or an error Response.
async function resolveCanonical(
  k: KitchenEnv,
  hid: string,
  body: any,
): Promise<{ id: string; canonical_name: string; category: string | null; default_unit: string | null } | Response> {
  if (typeof body.item_id === "string" && body.item_id) {
    const row: any = await k.DB.prepare(
      "SELECT * FROM shop_items WHERE id = ? AND household_id = ?",
    )
      .bind(body.item_id, hid)
      .first();
    if (!row) return err("item_not_found", 404);
    return {
      id: String(row.id),
      canonical_name: String(row.canonical_name),
      category: row.category ? String(row.category) : null,
      default_unit: row.default_unit ? String(row.default_unit) : null,
    };
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 200) return err("item_required", 400);
  const ids = await resolveItems(k, hid, [name]);
  const id = ids.get(canonicalName(name))!;
  const row: any = await k.DB.prepare("SELECT * FROM shop_items WHERE id = ?").bind(id).first();
  return {
    id,
    canonical_name: String(row.canonical_name),
    category: row.category ? String(row.category) : null,
    default_unit: row.default_unit ? String(row.default_unit) : null,
  };
}

// Set the category on the canonical item too (the catalogue learns).
async function setItemCategory(k: KitchenEnv, itemId: string, category: string): Promise<void> {
  await k.DB.prepare("UPDATE shop_items SET category = ? WHERE id = ?").bind(category, itemId).run();
}

// A category set on a recipe ingredient teaches the catalogue, the same
// mechanism as the Shop line edit: the category is stored on the
// ingredient's canonical shop_item, so future Shop lists group that
// item's lines under the heading. Runs AFTER the recipe save (its own
// awaits), so a catalogue update can never roll back the recipe itself.
// Ingredients without a category leave the stored category untouched.
async function applyIngredientCategories(
  k: KitchenEnv,
  itemIds: Map<string, string>,
  ingredients: IngredientIn[],
): Promise<void> {
  for (const ing of ingredients) {
    if (!ing.category) continue;
    const itemId = itemIds.get(canonicalName(ing.name));
    if (itemId) await setItemCategory(k, itemId, ing.category);
  }
}

function insertLineStmt(
  k: KitchenEnv,
  runId: string,
  hid: string,
  line: DerivedLine & { state?: string; carry_over?: number; added_by?: string | null },
): D1PreparedStatement {
  return k.DB.prepare(
    "INSERT INTO shop_list_items (id, run_id, household_id, item_id, display_name, quantity, unit, " +
      "is_rounded, unrounded_quantity, category, state, source, source_recipe_id, source_date, sources, carry_over, added_by, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    uid(),
    runId,
    hid,
    line.item_id,
    line.display_name,
    line.quantity,
    line.unit,
    line.is_rounded,
    line.unrounded_quantity,
    line.category,
    line.state ?? "to_buy",
    line.source,
    line.source_recipe_id,
    line.source_date,
    JSON.stringify(line.sources || []),
    line.carry_over ?? 0,
    line.added_by ?? null,
    nowIso(),
  );
}

// Ensure a pantry_out line exists in the active run for an Out pantry
// item: skip when ANY line for the item already exists in the run (a
// plan line already covers it); otherwise recompute its derived
// quantity from the run week's plan when the item is in the plan, else
// quantity null. Returns true when a line was inserted.
async function ensurePantryOutLine(k: KitchenEnv, hid: string, run: any, itemId: string): Promise<boolean> {
  const existing: any = await k.DB.prepare(
    "SELECT id FROM shop_list_items WHERE run_id = ? AND item_id = ? LIMIT 1",
  )
    .bind(String(run.id), itemId)
    .first();
  if (existing) return false;
  const item: any = await k.DB.prepare("SELECT * FROM shop_items WHERE id = ?").bind(itemId).first();
  if (!item) return false;
  const derived = await deriveFromPlan(k, hid, String(run.week_start));
  const match = derived.lines.find((l) => l.item_id === itemId && l.source === "plan");
  await insertLineStmt(k, String(run.id), hid, {
    item_id: itemId,
    display_name: String(item.canonical_name),
    quantity: match ? match.quantity : null,
    unit: match ? match.unit : item.default_unit ? String(item.default_unit) : null,
    is_rounded: match ? match.is_rounded : 0,
    unrounded_quantity: match ? match.unrounded_quantity : null,
    category: match ? match.category : item.category ? String(item.category) : null,
    source: "pantry_out",
    source_recipe_id: match ? match.source_recipe_id : null,
    source_date: match ? match.source_date : null,
    sources: match ? match.sources : [],
  }).run();
  return true;
}

// --- Shop routes ---

async function getShop(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const param = new URL(request.url).searchParams.get("week_start");
  const monday = param ? mondayOf(parseDate(param) ?? new Date()) : mondayOf(new Date());
  const weekStart = fmtDate(monday);
  const active = await activeRun(k, auth.hid);
  const run = await runForWeek(k, auth.hid, weekStart);
  const lines = run ? await shopLinesForRun(k, String(run.id)) : [];
  const lastBought = await lastBoughtMap(k, auth.hid);
  // plan_changed: recompute the fingerprint from the current plan; a
  // mismatch on a non-finished run means the plan changed after this
  // list was made. Finished runs are archived — plan changes don't
  // apply to them — and a missing run has nothing to compare. The
  // no-ingredients notice always reflects the current plan.
  let planChanged = false;
  let noIngredientRecipes: DeriveResult["noIngredientRecipes"] = [];
  if (run) {
    const derived = await deriveFromPlan(k, auth.hid, weekStart);
    noIngredientRecipes = derived.noIngredientRecipes;
    planChanged =
      String(run.status) !== "finished" &&
      Boolean(run.plan_fingerprint) &&
      run.plan_fingerprint !== derived.fingerprint;
  }
  return json({
    ok: true,
    week_start: weekStart,
    run: run ? runShape(run) : null,
    lines: lines.map((l) => lineShape(l, lastBought)),
    plan_changed: planChanged,
    no_ingredient_recipes: noIngredientRecipes,
    active_run_week_start: active ? String(active.week_start) : null,
  });
}

async function generateShop(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const body = await readBody(request);
  const weekDate = parseDate(String(body.week_start || ""));
  if (!weekDate || weekDate.getUTCDay() !== 1) return err("invalid_week", 400);
  const weekStart = fmtDate(weekDate);
  const thisMonday = fmtDate(mondayOf(new Date()));
  const nextMonday = fmtDate(addDays(mondayOf(new Date()), 7));
  if (weekStart !== thisMonday && weekStart !== nextMonday) return err("invalid_week", 400);
  const active = await activeRun(k, auth.hid);
  if (active && String(active.week_start) !== weekStart) return err("active_run_exists", 409);
  const derived = await deriveFromPlan(k, auth.hid, weekStart);
  const now = nowIso();
  const regenerated = Boolean(active);
  let runId: string;
  const writes: D1PreparedStatement[] = [];
  if (active) {
    runId = String(active.id);
    // Regenerate in place: derived (plan + pantry_out) lines are
    // rebuilt from the current plan; manual and carry_over lines stay
    // (a planner's own lines survive a re-plan; checked state on a
    // rebuilt plan line is lost with it, which is what Regenerate
    // means). Carry-over flags consumed here are cleared in this same
    // batch, so a second regenerate cannot re-append them.
    writes.push(
      k.DB.prepare("DELETE FROM shop_list_items WHERE run_id = ? AND source IN ('plan', 'pantry_out')").bind(runId),
      k.DB.prepare(
        "UPDATE shop_runs SET plan_id = ?, week_start = ?, plan_fingerprint = ? WHERE id = ?",
      ).bind(derived.planId, weekStart, derived.fingerprint, runId),
    );
  } else {
    runId = uid();
    writes.push(
      k.DB.prepare(
        "INSERT INTO shop_runs (id, household_id, plan_id, week_start, status, plan_fingerprint, created_by, created_at) " +
          "VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)",
      ).bind(runId, auth.hid, derived.planId, weekStart, derived.fingerprint, auth.userId, now),
    );
  }
  for (const line of derived.lines) writes.push(insertLineStmt(k, runId, auth.hid, line));
  for (const srcId of derived.carryOverSourceIds) {
    writes.push(k.DB.prepare("UPDATE shop_list_items SET carry_over = 0 WHERE id = ?").bind(srcId));
  }
  await k.DB.batch(writes);
  const run: any = await k.DB.prepare("SELECT * FROM shop_runs WHERE id = ?").bind(runId).first();
  const lines = await shopLinesForRun(k, runId);
  const lastBought = await lastBoughtMap(k, auth.hid);
  return json({
    ok: true,
    run: runShape(run),
    lines: lines.map((l) => lineShape(l, lastBought)),
    no_ingredient_recipes: derived.noIngredientRecipes,
    regenerated,
  });
}

async function addShopLine(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const active = await activeRun(k, auth.hid);
  if (!active) return err("no_active_run", 404);
  const body = await readBody(request);
  if (body.category !== undefined && body.category !== null && !isShopCategory(body.category)) {
    return err("invalid_category", 400);
  }
  const quantity = cleanQty(body.quantity);
  if (quantity === undefined) return err("invalid_quantity", 400);
  const unit = cleanUnit(body.unit);
  const item = await resolveCanonical(k, auth.hid, body);
  if (item instanceof Response) return item;
  const category = isShopCategory(body.category) ? body.category : item.category;
  if (isShopCategory(body.category)) await setItemCategory(k, item.id, body.category);
  const lineId = uid();
  const now = nowIso();
  await k.DB.prepare(
    "INSERT INTO shop_list_items (id, run_id, household_id, item_id, display_name, quantity, unit, " +
      "is_rounded, unrounded_quantity, category, state, source, source_recipe_id, source_date, sources, carry_over, added_by, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'to_buy', 'manual', NULL, NULL, '[]', 0, ?, ?)",
  )
    .bind(lineId, String(active.id), auth.hid, item.id, item.canonical_name, quantity, unit, category, auth.userId, now)
    .run();
  const row: any = await k.DB.prepare("SELECT * FROM shop_list_items WHERE id = ?").bind(lineId).first();
  const lastBought = await lastBoughtMap(k, auth.hid);
  return json({ ok: true, line: lineShape(row, lastBought) }, 201);
}

// Load a line and its run, enforcing the active-run guard shared by
// PATCH and DELETE: a line in a finished run is 409 run_finished, a
// line in no run the caller can touch is 404 line_not_found. (The only
// non-active runs are finished ones; a line in the active run passes.)
async function loadEditableLine(
  k: KitchenEnv,
  hid: string,
  lineId: string,
): Promise<{ line: any; run: any } | Response> {
  const line: any = await k.DB.prepare(
    "SELECT * FROM shop_list_items WHERE id = ? AND household_id = ?",
  )
    .bind(lineId, hid)
    .first();
  if (!line) return err("line_not_found", 404);
  const run: any = await k.DB.prepare("SELECT * FROM shop_runs WHERE id = ?").bind(String(line.run_id)).first();
  if (!run) return err("line_not_found", 404);
  if (String(run.status) === "finished") return err("run_finished", 409);
  const active = await activeRun(k, hid);
  if (!active || String(active.id) !== String(run.id)) return err("line_not_found", 404);
  return { line, run };
}

async function updateShopLine(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return err("line_required", 400);
  const loaded = await loadEditableLine(k, auth.hid, id);
  if (loaded instanceof Response) return loaded;
  const { line, run } = loaded;
  const body = await readBody(request);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.state !== undefined) {
    if (body.state !== "to_buy" && body.state !== "checked") return err("invalid_state", 400);
    sets.push("state = ?");
    binds.push(body.state);
  }
  if (body.quantity !== undefined) {
    const q = cleanQty(body.quantity);
    if (q === undefined) return err("invalid_quantity", 400);
    sets.push("quantity = ?");
    binds.push(q);
    // Editing a quantity clears the rounding flag: the planner took
    // ownership of the number, so "rounded up from X" no longer holds.
    sets.push("is_rounded = 0");
    sets.push("unrounded_quantity = NULL");
  }
  if (body.unit !== undefined) {
    sets.push("unit = ?");
    binds.push(cleanUnit(body.unit));
  }
  let newCategory: string | null | undefined;
  if (body.category !== undefined) {
    if (body.category !== null && !isShopCategory(body.category)) return err("invalid_category", 400);
    newCategory = body.category === null ? null : body.category;
    sets.push("category = ?");
    binds.push(newCategory);
  }
  const writes: D1PreparedStatement[] = [];
  if (sets.length > 0) {
    writes.push(
      k.DB.prepare(`UPDATE shop_list_items SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id),
    );
  }
  // First check-off moves a draft run to shopping, in the same batch.
  if (body.state === "checked" && String(run.status) === "draft") {
    writes.push(k.DB.prepare("UPDATE shop_runs SET status = 'shopping' WHERE id = ?").bind(String(run.id)));
  }
  if (writes.length > 0) await k.DB.batch(writes);
  // A category edit updates the canonical item too (the catalogue learns).
  if (newCategory !== undefined && newCategory !== null && line.item_id) {
    await setItemCategory(k, String(line.item_id), newCategory);
  }
  const row: any = await k.DB.prepare("SELECT * FROM shop_list_items WHERE id = ?").bind(id).first();
  const lastBought = await lastBoughtMap(k, auth.hid);
  return json({ ok: true, line: lineShape(row, lastBought) });
}

async function deleteShopLine(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return err("line_required", 400);
  const loaded = await loadEditableLine(k, auth.hid, id);
  if (loaded instanceof Response) return loaded;
  await k.DB.prepare("DELETE FROM shop_list_items WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function finishShopRun(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const active = await activeRun(k, auth.hid);
  if (!active) return err("no_active_run", 404);
  const body = await readBody(request);
  const runDateRaw = typeof body.run_date === "string" && body.run_date ? body.run_date : fmtDate(new Date());
  const runDate = parseDate(runDateRaw);
  if (!runDate || runDateRaw > fmtDate(new Date())) return err("invalid_run_date", 400);
  const store =
    typeof body.store === "string" && body.store.trim() ? body.store.trim().slice(0, 100) : null;
  // Prices apply to checked lines only; a price must be a finite
  // number >= 0, else the whole finish is rejected (no partial writes).
  const prices = new Map<string, number>();
  if (body.prices !== undefined && body.prices !== null) {
    if (!Array.isArray(body.prices)) return err("invalid_price", 400);
    for (const p of body.prices) {
      const price = typeof p?.price === "number" ? p.price : Number(p?.price);
      if (typeof p?.line_id !== "string" || !Number.isFinite(price) || price < 0) {
        return err("invalid_price", 400);
      }
      prices.set(p.line_id, price);
    }
  }
  const carryOverIds = new Set<string>();
  if (body.carry_over !== undefined && body.carry_over !== null) {
    if (!Array.isArray(body.carry_over)) return err("invalid_carry_over", 400);
    for (const v of body.carry_over) if (typeof v === "string") carryOverIds.add(v);
  }
  const lines = await shopLinesForRun(k, String(active.id));
  const checked = lines.filter((l: any) => String(l.state) === "checked");
  const toBuy = lines.filter((l: any) => String(l.state) === "to_buy");
  const now = nowIso();
  const writes: D1PreparedStatement[] = [];
  const purchases: any[] = [];
  for (const l of checked) {
    const price = prices.get(String(l.id));
    const lineTotal = price !== undefined ? round2(price) : null;
    const unitPrice =
      price !== undefined && typeof l.quantity === "number" && l.quantity > 0
        ? round2(price / l.quantity)
        : null;
    const purchaseId = uid();
    writes.push(
      k.DB.prepare(
        "INSERT INTO shop_purchases (id, run_id, item_id, quantity, unit, unit_price, line_total, bought_date, bought_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        purchaseId,
        String(active.id),
        String(l.item_id),
        l.quantity ?? null,
        l.unit ?? null,
        unitPrice,
        lineTotal,
        runDateRaw,
        auth.userId,
        now,
      ),
    );
    purchases.push({
      id: purchaseId,
      item_id: String(l.item_id),
      display_name: String(l.display_name),
      quantity: l.quantity ?? null,
      unit: l.unit ?? null,
      line_total: lineTotal,
      unit_price: unitPrice,
      bought_date: runDateRaw,
    });
  }
  let carriedOver = 0;
  for (const l of toBuy) {
    if (!carryOverIds.has(String(l.id))) continue;
    writes.push(k.DB.prepare("UPDATE shop_list_items SET carry_over = 1 WHERE id = ?").bind(String(l.id)));
    carriedOver++;
  }
  // All writes in ONE batch: purchase inserts + carry-over flags + the
  // run finishing — all-or-nothing. Checked and to-buy lines STAY on
  // the finished run as the archived record.
  writes.push(
    k.DB.prepare(
      "UPDATE shop_runs SET status = 'finished', finished_at = ?, run_date = ?, store = ? WHERE id = ?",
    ).bind(now, runDateRaw, store, String(active.id)),
  );
  await k.DB.batch(writes);
  const run: any = await k.DB.prepare("SELECT * FROM shop_runs WHERE id = ?").bind(String(active.id)).first();
  return json({ ok: true, run: runShape(run), purchases, purchased: purchases.length, carried_over: carriedOver });
}

async function searchShopItems(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const limitRaw = Number(url.searchParams.get("limit") || "20");
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 50) : 20;
  // LIKE wildcards in the query are escaped so they match literally.
  const like = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const { results } = await k.DB.prepare(
    "SELECT id, canonical_name, category, default_unit FROM shop_items " +
      "WHERE household_id = ? AND canonical_name LIKE ? ESCAPE '\\' ORDER BY canonical_name LIMIT ?",
  )
    .bind(auth.hid, like, limit)
    .all();
  const lastBought = await lastBoughtMap(k, auth.hid);
  return json({
    ok: true,
    items: (results as any[]).map((r: any) => {
      const lb = lastBought.get(String(r.id));
      return {
        id: String(r.id),
        name: String(r.canonical_name),
        category: r.category ? String(r.category) : null,
        last_bought_date: lb?.date ?? null,
        last_unit_price: lb?.unit_price ?? null,
      };
    }),
  });
}

// --- Pantry routes ---

function pantryShape(p: any, lastBought: Map<string, { date: string; unit_price: number | null }>) {
  const lb = lastBought.get(String(p.item_id));
  return {
    item_id: String(p.item_id),
    name: String(p.name),
    category: p.category ? String(p.category) : null,
    on_hand: String(p.on_hand),
    last_bought_date: lb?.date ?? null,
  };
}

async function listPantry(_request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const { results } = await k.DB.prepare(
    "SELECT p.item_id AS item_id, p.on_hand AS on_hand, s.canonical_name AS name, s.category AS category " +
      "FROM shop_pantry_items p JOIN shop_items s ON s.id = p.item_id WHERE p.household_id = ? " +
      "ORDER BY CASE s.category WHEN 'Produce' THEN 0 WHEN 'Meat and seafood' THEN 1 " +
      "WHEN 'Dairy and chilled' THEN 2 WHEN 'Pantry and dry' THEN 3 ELSE 4 END, s.canonical_name",
  )
    .bind(auth.hid)
    .all();
  const lastBought = await lastBoughtMap(k, auth.hid);
  return json({ ok: true, items: (results as any[]).map((p) => pantryShape(p, lastBought)) });
}

async function addPantryItem(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const body = await readBody(request);
  if (body.category !== undefined && body.category !== null && !isShopCategory(body.category)) {
    return err("invalid_category", 400);
  }
  const onHand = body.on_hand === undefined || body.on_hand === null ? "have" : body.on_hand;
  if (onHand !== "have" && onHand !== "out") return err("invalid_on_hand", 400);
  const item = await resolveCanonical(k, auth.hid, body);
  if (item instanceof Response) return item;
  if (isShopCategory(body.category)) await setItemCategory(k, item.id, body.category);
  // Idempotent: an existing row is returned as-is (200), not an error.
  await k.DB.prepare(
    "INSERT OR IGNORE INTO shop_pantry_items (household_id, item_id, on_hand) VALUES (?, ?, ?)",
  )
    .bind(auth.hid, item.id, onHand)
    .run();
  const row: any = await k.DB.prepare(
    "SELECT p.item_id AS item_id, p.on_hand AS on_hand, s.canonical_name AS name, s.category AS category " +
      "FROM shop_pantry_items p JOIN shop_items s ON s.id = p.item_id WHERE p.household_id = ? AND p.item_id = ?",
  )
    .bind(auth.hid, item.id)
    .first();
  // The STORED state decides (a re-add returns the existing row
  // unchanged): Out ensures the pantry_out line, Have removes the
  // item's lines from the active run — same as the PATCH toggle, so
  // adding a staple as Have never leaves a stale line behind.
  const active = await activeRun(k, auth.hid);
  if (active) {
    if (String(row.on_hand) === "out") {
      await ensurePantryOutLine(k, auth.hid, active, item.id);
    } else {
      await k.DB.prepare("DELETE FROM shop_list_items WHERE run_id = ? AND item_id = ?")
        .bind(String(active.id), item.id)
        .run();
    }
  }
  const lastBought = await lastBoughtMap(k, auth.hid);
  return json({ ok: true, item: pantryShape(row, lastBought) });
}

async function updatePantryItem(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const itemId = new URL(request.url).searchParams.get("item_id");
  if (!itemId) return err("pantry_item_required", 400);
  const body = await readBody(request);
  if (body.on_hand !== "have" && body.on_hand !== "out") return err("invalid_on_hand", 400);
  const existing: any = await k.DB.prepare(
    "SELECT * FROM shop_pantry_items WHERE household_id = ? AND item_id = ?",
  )
    .bind(auth.hid, itemId)
    .first();
  if (!existing) return err("pantry_item_not_found", 404);
  await k.DB.prepare("UPDATE shop_pantry_items SET on_hand = ? WHERE household_id = ? AND item_id = ?")
    .bind(body.on_hand, auth.hid, itemId)
    .run();
  const active = await activeRun(k, auth.hid);
  if (active) {
    if (body.on_hand === "out") {
      await ensurePantryOutLine(k, auth.hid, active, itemId);
    } else {
      // Have removes that line — every active-run line for the item,
      // whatever its source, is now covered by the pantry.
      await k.DB.prepare("DELETE FROM shop_list_items WHERE run_id = ? AND item_id = ?")
        .bind(String(active.id), itemId)
        .run();
    }
  }
  const row: any = await k.DB.prepare(
    "SELECT p.item_id AS item_id, p.on_hand AS on_hand, s.canonical_name AS name, s.category AS category " +
      "FROM shop_pantry_items p JOIN shop_items s ON s.id = p.item_id WHERE p.household_id = ? AND p.item_id = ?",
  )
    .bind(auth.hid, itemId)
    .first();
  const lastBought = await lastBoughtMap(k, auth.hid);
  return json({ ok: true, item: pantryShape(row, lastBought) });
}

async function deletePantryItem(request: Request, env: unknown, ctx: AuthContext | null) {
  const auth = requireHousehold(ctx);
  if (auth instanceof Response) return auth;
  const k = env as KitchenEnv;
  const itemId = new URL(request.url).searchParams.get("item_id");
  if (!itemId) return err("pantry_item_required", 400);
  const meta = await k.DB.prepare("DELETE FROM shop_pantry_items WHERE household_id = ? AND item_id = ?")
    .bind(auth.hid, itemId)
    .run();
  if (((meta.meta as any)?.changes ?? 0) === 0) return err("pantry_item_not_found", 404);
  // Deliberate: deleting a pantry tracking row does NOT touch the shop
  // list — the shopping need survives the tracking row.
  return json({ ok: true });
}

export const kitchenApiRoutes: ApiRoute[] = [
  { method: "GET", path: "/api/kitchen/recipes", handler: listRecipes },
  { method: "POST", path: "/api/kitchen/recipes", handler: createRecipe },
  { method: "PATCH", path: "/api/kitchen/recipes", handler: updateRecipe },
  { method: "DELETE", path: "/api/kitchen/recipes", handler: archiveRecipe },
  { method: "POST", path: "/api/kitchen/recipes/restore", handler: restoreRecipe },
  { method: "GET", path: "/api/kitchen/plan", handler: getPlan },
  { method: "POST", path: "/api/kitchen/plan/slot", handler: setSlot },
  { method: "DELETE", path: "/api/kitchen/plan/slot", handler: clearSlot },
  { method: "POST", path: "/api/kitchen/plan/copy-forward", handler: copyForward },
  { method: "POST", path: "/api/kitchen/plan/resolve", handler: resolveSlot },
  { method: "POST", path: "/api/kitchen/plan/cook-something-else", handler: cookSomethingElse },
  { method: "GET", path: "/api/kitchen/today", handler: getToday },
  { method: "GET", path: "/api/kitchen/next-meal", handler: getNextMeal },
  { method: "GET", path: "/api/kitchen/shop", handler: getShop },
  { method: "POST", path: "/api/kitchen/shop/generate", handler: generateShop },
  { method: "POST", path: "/api/kitchen/shop/lines", handler: addShopLine },
  { method: "PATCH", path: "/api/kitchen/shop/lines", handler: updateShopLine },
  { method: "DELETE", path: "/api/kitchen/shop/lines", handler: deleteShopLine },
  { method: "POST", path: "/api/kitchen/shop/finish", handler: finishShopRun },
  { method: "GET", path: "/api/kitchen/shop/items", handler: searchShopItems },
  { method: "GET", path: "/api/kitchen/pantry", handler: listPantry },
  { method: "POST", path: "/api/kitchen/pantry", handler: addPantryItem },
  { method: "PATCH", path: "/api/kitchen/pantry", handler: updatePantryItem },
  { method: "DELETE", path: "/api/kitchen/pantry", handler: deletePantryItem },
];
