import { addDays, applyStates, assignMeals, buildLines, type ItemState, type PlannedMeal, type Recipe, type RecipeLine, type Trip } from "@haven/meals-core";
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
export interface MealRow extends Row { date: string; slot: string; recipe_id: string; servings: number; status: "planned" | "skipped"; bought_on_trip_id?: string | null; include_optional?: string[]; recipe_snapshot?: { title: string; base_servings: number; ingredients: StoredLine[] } | null }
export interface TripRow extends Row { date: string; kind: "regular" | "topup"; status: string; finished_at?: number | null; reopen_until?: number | null; final_lines?: unknown }
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
  const regular = d.trips.filter((t) => t.kind === "regular").map(tripOf);
  const { byTrip } = assignMeals(regular, d.meals.map(mealOf));
  // Meals already bought on an earlier trip don't add to this one (PRD › Meals that didn't happen).
  const bought = new Map(d.meals.map((m) => [m.id, m.bought_on_trip_id]));
  const meals = trip.kind === "regular" ? (byTrip.get(trip.id) ?? []).filter((m) => !bought.get(m.id) || bought.get(m.id) === trip.id) : [];
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
