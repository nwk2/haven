import type { MeasurementSystem } from "./types";

/** Families never convert into each other (no densities in v1). */
export type Family = "mass" | "volume" | "spoon" | `count:${string}` | "taste";

/** Factor to the family's base unit: g, ml, tsp, or 1 for counts. */
const UNITS: Record<string, { family: "mass" | "volume" | "spoon"; toBase: number }> = {
  g: { family: "mass", toBase: 1 },
  kg: { family: "mass", toBase: 1000 },
  oz: { family: "mass", toBase: 28.35 },
  lb: { family: "mass", toBase: 453.6 },
  ml: { family: "volume", toBase: 1 },
  l: { family: "volume", toBase: 1000 },
  floz: { family: "volume", toBase: 30 },
  cup: { family: "volume", toBase: 240 },
  tsp: { family: "spoon", toBase: 1 },
  tbsp: { family: "spoon", toBase: 3 },
};

export function familyOf(unit: string | undefined, toTaste = false): Family {
  if (toTaste) return "taste";
  const u = (unit ?? "whole").toLowerCase();
  return UNITS[u]?.family ?? (`count:${u}` as const);
}

export function toBase(qty: number, unit: string | undefined): number {
  const u = (unit ?? "whole").toLowerCase();
  return qty * (UNITS[u]?.toBase ?? 1);
}

const ceilTo = (x: number, step: number) => Math.ceil(x / step - 1e-9) * step;
const nearest = (x: number, step: number) => Math.round(x / step) * step;

export interface Display { qty?: number; unit?: string }

/**
 * Converts a merged total (in base units) into what the list shows, per
 * PRD › Servings and scaling and › Units and week start.
 */
export function display(family: Family, base: number, system: MeasurementSystem): Display {
  if (family === "taste") return {};
  if (family.startsWith("count:")) {
    return { qty: Math.max(1, ceilTo(base, 1)), unit: family.slice(6) };
  }
  if (family === "spoon") {
    const tsp = Math.max(0.25, nearest(base, 0.25));
    return tsp >= 3 ? { qty: Math.max(0.25, nearest(tsp / 3, 0.25)), unit: "tbsp" } : { qty: tsp, unit: "tsp" };
  }
  if (system === "metric") {
    const r = base < 100 ? ceilTo(base, 5) : ceilTo(base, 25);
    const small = family === "mass" ? "g" : "ml";
    const big = family === "mass" ? "kg" : "l";
    return r >= 1000 ? { qty: r / 1000, unit: big } : { qty: r, unit: small };
  }
  if (family === "mass") {
    const oz = base / 28.35;
    return oz < 16 ? { qty: Math.max(0.5, ceilTo(oz, 0.5)), unit: "oz" } : { qty: ceilTo(oz / 16, 0.25), unit: "lb" };
  }
  const floz = base / 30;
  return floz < 8 ? { qty: Math.max(0.5, ceilTo(floz, 0.5)), unit: "fl oz" } : { qty: ceilTo(base / 240, 0.25), unit: "cup" };
}
