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
