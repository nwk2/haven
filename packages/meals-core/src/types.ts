/** A household-local calendar date, YYYY-MM-DD. */
export type LocalDate = string;

export type MeasurementSystem = "metric" | "us";

export interface RecipeLine {
  ingredientId: string;
  qty?: number;        // missing for "to taste"
  unit?: string;       // see units.ts
  optional?: boolean;
  toTaste?: boolean;
}

export interface Recipe {
  id: string;
  baseServings: number;
  ingredients: RecipeLine[];
}

export interface PlannedMeal {
  id: string;
  date: LocalDate;
  recipeId: string;
  servings: number;
  status: "planned" | "skipped";
  /** Optional lines the household chose to include for this meal. */
  includeOptional?: string[];
}

export interface ItemState {
  key: string;
  checked: boolean;
  /** Amount bought, in the family's base unit (g, ml, tsp or count). */
  boughtQty?: number;
  haveIt?: boolean;
  unavailable?: boolean;
}
