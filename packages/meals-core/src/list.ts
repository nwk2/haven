import { display, familyOf, toBase, type Display, type Family } from "./units";
import type { ItemState, MeasurementSystem, PlannedMeal, Recipe } from "./types";

export interface Source { mealId: string; recipeId: string; base: number }

export interface Line {
  key: string;              // ingredientId + "_" + family
  ingredientId: string;
  family: Family;
  base: number;             // merged total needed, in base units (0 for to taste)
  shown: Display;           // converted and rounded for the household
  sources: Source[];
}

export type LineState =
  | { kind: "todo" }
  | { kind: "inCart" }
  | { kind: "needsMore"; more: Display }
  | { kind: "haveIt" }
  | { kind: "unavailable" };

export interface ListRow { line: Line; state: LineState }
export interface ComputedList { rows: ListRow[]; noLongerNeeded: ItemState[] }

/**
 * State for one meal's share of a line. Stored per meal-ingredient (meals_list_states),
 * never per combined line, so next week's garlic doesn't show up already bought.
 * boughtQty missing means "this meal's full share"; cleared means "bought, then hidden
 * by Clear bought" — it stays hidden until the meal is re-planned.
 */
export interface SourceState {
  mealId: string;
  key: string;              // line key (ingredientId_family)
  checked: boolean;
  boughtQty?: number;       // base units, for this meal's share
  haveIt?: boolean;
  cleared?: boolean;
}

const keyOf = (ingredientId: string, family: Family) =>
  `${ingredientId}_${family.replace("count:", "count-")}`;

/** Scales, merges and rounds every ingredient of the given meals. */
export function buildLines(meals: PlannedMeal[], recipes: Map<string, Recipe>, system: MeasurementSystem): Line[] {
  const lines = new Map<string, Line>();
  for (const meal of meals) {
    const recipe = recipes.get(meal.recipeId);
    if (!recipe) continue;
    const factor = meal.servings / recipe.baseServings;
    for (const l of recipe.ingredients) {
      if (l.optional && !meal.includeOptional?.includes(l.ingredientId)) continue;
      const toTaste = l.toTaste || l.qty == null;
      const family = familyOf(l.unit, toTaste);
      const base = toTaste ? 0 : toBase(l.qty! * factor, l.unit);
      const key = keyOf(l.ingredientId, family);
      const line = lines.get(key) ?? { key, ingredientId: l.ingredientId, family, base: 0, shown: {}, sources: [] };
      line.base += base;
      line.sources.push({ mealId: meal.id, recipeId: recipe.id, base });
      lines.set(key, line);
    }
  }
  // Round the merged total, never each meal: two half cans make one can.
  for (const line of lines.values()) line.shown = display(line.family, line.base, system);
  return [...lines.values()];
}

/** Overlays stored item states on the computed lines. */
export function applyStates(lines: Line[], states: ItemState[], system: MeasurementSystem): ComputedList {
  const byKey = new Map(states.map((s) => [s.key, s]));
  const rows: ListRow[] = lines.map((line) => {
    const s = byKey.get(line.key);
    if (!s) return { line, state: { kind: "todo" } };
    if (s.haveIt) return { line, state: { kind: "haveIt" } };
    if (s.unavailable && !s.checked) return { line, state: { kind: "unavailable" } };
    if (!s.checked) return { line, state: { kind: "todo" } };
    const bought = s.boughtQty ?? line.base;
    if (line.family !== "taste" && bought + 1e-9 < line.base) {
      return { line, state: { kind: "needsMore", more: display(line.family, line.base - bought, system) } };
    }
    return { line, state: { kind: "inCart" } };
  });
  const live = new Set(lines.map((l) => l.key));
  const noLongerNeeded = states.filter((s) => s.checked && !live.has(s.key) && !s.key.startsWith("extra_"));
  return { rows, noLongerNeeded };
}

/**
 * The one-list overlay: per-meal-ingredient states over the combined lines.
 * A source that is have-it or cleared contributes nothing to what is still needed;
 * the line shows only the remaining amount, across the meals still to buy for.
 * A line whose every source is have-it reads haveIt; one whose every source is
 * cleared (or cleared + have-it) is hidden entirely — Clear bought took it off
 * the list, and it stays off until a new meal needs that ingredient.
 * Partial buying still works on the line total: bought is the sum of the bought
 * shares, needed is the sum of the shares still to buy.
 */
export function applySourceStates(lines: Line[], states: SourceState[], system: MeasurementSystem): ComputedList {
  const byKey = new Map<string, Map<string, SourceState>>();
  for (const s of states) {
    if (s.key.startsWith("extra_")) continue;
    let m = byKey.get(s.key);
    if (!m) byKey.set(s.key, (m = new Map()));
    m.set(s.mealId, s);
  }
  const visible: Line[] = [];
  const agg: ItemState[] = [];
  for (const line of lines) {
    const perMeal = byKey.get(line.key) ?? new Map<string, SourceState>();
    const active = line.sources.filter((s) => { const st = perMeal.get(s.mealId); return !st?.haveIt && !st?.cleared; });
    if (!active.length) {
      // Nothing left to buy for: have-it when every source is have-it, hidden otherwise.
      if (line.sources.length && line.sources.every((s) => perMeal.get(s.mealId)?.haveIt)) {
        visible.push(line);
        agg.push({ key: line.key, checked: false, haveIt: true });
      }
      continue;
    }
    const needed = active.reduce((n, s) => n + s.base, 0);
    const bought = active.reduce((n, s) => { const st = perMeal.get(s.mealId); return n + (st?.checked ? st.boughtQty ?? s.base : 0); }, 0);
    visible.push({ ...line, base: needed, shown: display(line.family, needed, system) });
    agg.push({ key: line.key, checked: active.some((s) => perMeal.get(s.mealId)?.checked), boughtQty: bought });
  }
  const { rows } = applyStates(visible, agg, system);
  return { rows, noLongerNeeded: [] };
}
