import { addDays, applyStates, buildLines, type ItemState, type PlannedMeal, type Recipe, type RecipeLine, type Trip } from "@haven/meals-core";
import type { Row } from "@haven/sync";
import { itemId } from "@haven/sync";
import { useLiveQuery } from "dexie-react-hooks";
import { useCtx, type ModuleCtx } from "./ctx";

export const SECTIONS = [
  ["produce", "Produce"], ["meat_fish", "Meat & fish"], ["dairy", "Dairy"], ["bakery", "Bakery"], ["pantry", "Pantry"], ["frozen", "Frozen"], ["other", "Other"],
] as const;
export type Section = (typeof SECTIONS)[number][0];
export const sectionName = (s: string) => SECTIONS.find(([k]) => k === s)?.[1] ?? "Other";
export const SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface Ingredient extends Row { name: string; section: Section; default_unit?: string; merged_into?: string | null }
export interface RecipeRow extends Row { title: string; base_servings: number; ingredients: StoredLine[]; steps: string[]; tags: string[]; source?: string; archived_at?: number | null }
export interface StoredLine extends RecipeLine { note?: string; group?: string }
export interface MealRow extends Row { date: string; slot: string; recipe_id: string; servings: number; status: "planned" | "skipped"; run_id?: string | null; bought_on_trip_id?: string | null; include_optional?: string[]; recipe_snapshot?: { title: string; base_servings: number; ingredients: StoredLine[] } | null }
export interface TripRow extends Row { date: string; kind: "regular" | "topup"; name?: string | null; status: string; finished_at?: number | null; reopen_until?: number | null; final_lines?: unknown }
export interface ItemRow extends Row { trip_id: string; key: string; checked?: number; checked_by?: string; bought_qty?: number; unavailable?: number; have_it?: number; carried_from?: string; label?: string; qty?: number; unit?: string; section?: string }

const live = (r: Row) => !r.deleted;

/** Everything the module screens read, live from IndexedDB. */
export function useMealsData() {
  const { db } = useCtx();
  return useLiveQuery(async () => {
    const [ingredients, recipes, meals, trips, items] = await Promise.all([
      db.meals_ingredients.toArray(), db.meals_recipes.toArray(), db.meals_planned.toArray(), db.meals_trips.toArray(), db.meals_items.toArray(),
    ]);
    return {
      ingredients: new Map((ingredients.filter(live) as Ingredient[]).map((i) => [i.id, i])),
      recipes: (recipes.filter(live) as RecipeRow[]).sort((a, b) => a.title.localeCompare(b.title)),
      meals: meals.filter(live) as MealRow[],
      trips: (trips.filter(live) as TripRow[]).sort((a, b) => a.date.localeCompare(b.date)),
      items: items.filter(live) as ItemRow[],
    };
  }, [db]);
}
export type MealsData = NonNullable<ReturnType<typeof useMealsData>>;

/** Resolves merged ingredients to the surviving entry. */
export const ingredientOf = (d: MealsData, id: string): Ingredient | undefined => {
  let i = d.ingredients.get(id); let hops = 0;
  while (i?.merged_into && hops++ < 5) i = d.ingredients.get(i.merged_into);
  return i;
};

export function toRecipe(r: RecipeRow, d: MealsData): Recipe {
  return { id: r.id, baseServings: r.base_servings, ingredients: (r.ingredients ?? []).map((l) => ({ ...l, ingredientId: ingredientOf(d, l.ingredientId)?.id ?? l.ingredientId })) };
}

export function mealOf(m: MealRow): PlannedMeal {
  return { id: m.id, date: m.date, recipeId: m.recipe_id, servings: m.servings, status: m.status, includeOptional: m.include_optional };
}

export const tripOf = (t: TripRow): Trip => ({ id: t.id, date: t.date, kind: t.kind });

/** The shopping list for one trip (PRD › Key rules; meals-core). */
export function listFor(d: MealsData, trip: TripRow, system: "metric" | "us") {
  // A run buys exactly the meals assigned to it (decision, Nov 2026: pick the meals).
  // Meals already bought on another run don't add again (PRD › Meals that didn't happen).
  const meals = d.meals.filter((m) => m.run_id === trip.id && m.status === "planned" && (!m.bought_on_trip_id || m.bought_on_trip_id === trip.id)).map(mealOf);
  const recipes = new Map(d.recipes.map((r) => [r.id, toRecipe(r, d)]));
  // Deleted recipes: planned meals keep a read-only copy (PRD › Edge cases).
  for (const m of meals) {
    const snap = d.meals.find((x) => x.id === m.id)?.recipe_snapshot;
    if (!recipes.has(m.recipeId) && snap) recipes.set(m.recipeId, toRecipe({ id: m.recipeId, title: snap.title, base_servings: snap.base_servings, ingredients: snap.ingredients, steps: [], tags: [] } as RecipeRow, d));
  }
  const lines = buildLines(meals, recipes, system);
  const rows = d.items.filter((i) => i.trip_id === trip.id);
  const states: ItemState[] = rows.filter((r) => !r.key.startsWith("extra_")).map((r) => ({ key: r.key, checked: !!r.checked, boughtQty: r.bought_qty ?? undefined, haveIt: !!r.have_it, unavailable: !!r.unavailable }));
  const computed = applyStates(lines, states, system);
  const extras = rows.filter((r) => r.key.startsWith("extra_"));
  return { ...computed, extras, meals };
}

export function useMutate() {
  const { sync, user } = useCtx();
  return {
    put: (table: Parameters<ModuleCtx["sync"]["mutate"]>[0], id: string, fields: Record<string, unknown>) => sync.mutate(table, id, fields),
    activity: (text: string) => sync.mutate("activity", crypto.randomUUID(), { module_id: "meals", member_id: user.id, text, at: Date.now() }),
    item: (tripId: string, key: string, fields: Record<string, unknown>) => sync.mutate("meals_items", itemId(tripId, key), { trip_id: tripId, key, ...fields }),
  };
}

export const newId = () => crypto.randomUUID();

const intl = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...o, timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
/** "Mon 23" by default (some locales would print "23 Mon"); other options go straight to Intl. */
export const fmt = (d: string, o?: Intl.DateTimeFormatOptions) =>
  o ? intl(d, o) : `${intl(d, { weekday: "short" })} ${intl(d, { day: "numeric" })}`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Ingredient names are stored with a capital first letter. */
export const nameCase = (s: string) => s.trim().charAt(0).toUpperCase() + s.trim().slice(1);

export const qtyText = (q?: number) => {
  if (q == null) return "";
  const whole = Math.floor(q); const frac = q - whole;
  const f = Math.abs(frac - 0.25) < 0.01 ? "¼" : Math.abs(frac - 0.5) < 0.01 ? "½" : Math.abs(frac - 0.75) < 0.01 ? "¾" : "";
  if (f) return whole ? `${whole}${f}` : f;
  return String(Math.round(q * 100) / 100);
};
export const unitText = (u?: string, q?: number) => {
  if (!u || u === "whole") return "";
  const plural = q != null && q > 1 && ["can", "pack", "clove", "bunch", "slice", "pinch", "cup"].includes(u);
  return (u === "floz" ? "fl oz" : u) + (plural ? (u === "bunch" || u === "pinch" ? "es" : "s") : "");
};
export const amount = (q?: number, u?: string) => [qtyText(q), unitText(u, q)].filter(Boolean).join(" ");

/* ── Grocery runs (decision, Nov 2026: a run holds the meals you pick; several can share a day) ── */

/** All runs not deleted, in date order (ties: oldest first). */
/** Same-day runs order by id: stable, unlike versions, which change on every edit. */
export const allRuns = (d: MealsData) => d.trips.slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
export const upcomingRuns = (d: MealsData) => allRuns(d).filter((t) => t.status !== "finished");

/** "Sun 22", "Sun 22 · Market", or "Sun 22 (2nd)" when several unnamed runs share the day. */
export function runName(d: MealsData, run: TripRow) {
  if (run.name) return `${fmt(run.date)} · ${run.name}`;
  const unnamed = allRuns(d).filter((t) => t.date === run.date && !t.name && t.status !== "finished");
  const i = unnamed.findIndex((t) => t.id === run.id);
  return i <= 0 ? fmt(run.date) : `${fmt(run.date)} (${ordinal(i + 1)})`;
}
/** Colour 1–4, stable per run in date order. */
export const runColor = (d: MealsData, run: TripRow) => (allRuns(d).findIndex((t) => t.id === run.id) % 4) + 1;
export const mealsOnRun = (d: MealsData, run: TripRow) => d.meals.filter((m) => m.run_id === run.id && m.status === "planned").sort((a, b) => a.date.localeCompare(b.date));
export const extrasOnRun = (d: MealsData, run: TripRow) => d.items.filter((i) => i.trip_id === run.id && i.key.startsWith("extra_"));
/** Nothing on it at all: no meals, no extra items, nothing checked. Such runs are removed when their last meal moves away. */
export const runIsEmpty = (d: MealsData, run: TripRow, mealIdsLeaving: string[] = []) =>
  !mealsOnRun(d, run).some((m) => !mealIdsLeaving.includes(m.id)) && !extrasOnRun(d, run).length && !d.items.some((i) => i.trip_id === run.id && i.checked);
export const runSummary = (d: MealsData, run: TripRow) => {
  const n = mealsOnRun(d, run).length, x = extrasOnRun(d, run).length;
  return [n ? plural(n, "meal") : "No meals", x ? plural(x, "extra item") : ""].filter(Boolean).join(" · ");
};

/** 2 → "2nd", 3 → "3rd", 5 → "5th", 11 → "11th", 22 → "22nd". */
export function ordinal(n: number) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
