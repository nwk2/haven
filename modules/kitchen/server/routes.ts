// Kitchen module server routes — Batch 3: Recipes, Plan, Today.
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
      "SELECT i.*, s.canonical_name AS item_name FROM cook_recipe_ingredients i " +
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
type IngredientIn = { name: string; quantity: number | null; unit: string | null; prep_note: string | null };
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
];
