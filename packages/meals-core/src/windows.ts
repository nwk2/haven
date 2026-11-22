import { addDays } from "./dates";
import type { LocalDate, PlannedMeal, Trip } from "./types";

export interface Window { tripId: string; from: LocalDate; to: LocalDate }

export const LAST_WINDOW_DAYS = 14;

/**
 * Each regular trip covers its date up to the day before the next regular
 * trip; the last one covers up to 14 days ahead. Top-up trips have no window.
 */
export function shoppingWindows(trips: Trip[]): Window[] {
  const regular = trips.filter((t) => t.kind === "regular").sort((a, b) => a.date.localeCompare(b.date));
  return regular.map((t, i) => ({
    tripId: t.id,
    from: t.date,
    to: i + 1 < regular.length ? addDays(regular[i + 1].date, -1) : addDays(t.date, LAST_WINDOW_DAYS - 1),
  }));
}

export interface Assignment { byTrip: Map<string, PlannedMeal[]>; notOnList: PlannedMeal[] }

/** Puts each planned (not skipped) meal into the window its date falls in. */
export function assignMeals(trips: Trip[], meals: PlannedMeal[]): Assignment {
  const windows = shoppingWindows(trips);
  const byTrip = new Map<string, PlannedMeal[]>(windows.map((w) => [w.tripId, []]));
  const notOnList: PlannedMeal[] = [];
  for (const m of meals) {
    if (m.status !== "planned") continue;
    const w = windows.find((w) => m.date >= w.from && m.date <= w.to);
    if (w) byTrip.get(w.tripId)!.push(m);
    else notOnList.push(m);
  }
  return { byTrip, notOnList };
}
