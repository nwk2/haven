import { describe, expect, it } from "vitest";
import { applySourceStates, applyStates, buildLines, display, type PlannedMeal, type Recipe } from "../src";

const meal = (id: string, date: string, recipeId: string, servings: number, extra: Partial<PlannedMeal> = {}): PlannedMeal =>
  ({ id, date, recipeId, servings, status: "planned", ...extra });

const recipes = new Map<string, Recipe>([
  ["tacos", { id: "tacos", baseServings: 4, ingredients: [
    { ingredientId: "beans", qty: 2, unit: "can" },
    { ingredientId: "feta", qty: 150, unit: "g" },
    { ingredientId: "salt", toTaste: true },
    { ingredientId: "chilli", qty: 0.5, unit: "tsp", optional: true },
  ] }],
  ["salad", { id: "salad", baseServings: 2, ingredients: [
    { ingredientId: "feta", qty: 100, unit: "g" },
    { ingredientId: "salt", toTaste: true },
  ] }],
  ["bread", { id: "bread", baseServings: 1, ingredients: [
    { ingredientId: "flour", qty: 1, unit: "cup" },
    { ingredientId: "flour", qty: 200, unit: "g" },
  ] }],
  ["onecan", { id: "onecan", baseServings: 2, ingredients: [{ ingredientId: "beans", qty: 1, unit: "can" }] }],
]);

describe("merging and scaling (PRD › Servings and scaling)", () => {
  it("merges feta 150 g + 100 g = 250 g", () => {
    const lines = buildLines([meal("b", "x", "tacos", 4), meal("c", "x", "salad", 2)], recipes, "metric");
    const feta = lines.find((l) => l.ingredientId === "feta")!;
    expect(feta.shown).toEqual({ qty: 250, unit: "g" });
    expect(feta.sources).toHaveLength(2);
  });
  it("lists to-taste once with no amount, and skips optional lines unless included", () => {
    const lines = buildLines([meal("b", "x", "tacos", 4), meal("c", "x", "salad", 2)], recipes, "metric");
    const salt = lines.filter((l) => l.ingredientId === "salt");
    expect(salt).toHaveLength(1);
    expect(salt[0].shown).toEqual({});
    expect(lines.some((l) => l.ingredientId === "chilli")).toBe(false);
    const withChilli = buildLines([meal("b", "x", "tacos", 4, { includeOptional: ["chilli"] })], recipes, "metric");
    expect(withChilli.find((l) => l.ingredientId === "chilli")!.shown).toEqual({ qty: 0.5, unit: "tsp" });
  });
  it("rounds countables up: 1.5 cans becomes 2", () => {
    const lines = buildLines([meal("b", "x", "tacos", 3)], recipes, "metric");
    expect(lines.find((l) => l.ingredientId === "beans")!.shown).toEqual({ qty: 2, unit: "can" });
  });
  it("rounds the merged total, not each meal: two half cans make one can", () => {
    const lines = buildLines([meal("p", "x", "onecan", 1), meal("q", "x", "onecan", 1)], recipes, "metric");
    expect(lines.find((l) => l.ingredientId === "beans")!.shown).toEqual({ qty: 1, unit: "can" });
  });
  it("keeps weight and volume apart (1 cup flour and 200 g flour)", () => {
    const lines = buildLines([meal("r", "x", "bread", 1)], recipes, "metric");
    expect(lines.filter((l) => l.ingredientId === "flour").map((l) => l.shown)).toEqual([
      { qty: 250, unit: "ml" }, // 1 cup = 240 ml, rounded up to the nearest 25
      { qty: 200, unit: "g" },
    ]);
  });
});

describe("rounding and units (PRD › Units and week start)", () => {
  it("metric: 310 g → 325 g, 37 g → 40 g, 1,250 g → 1.25 kg", () => {
    expect(display("mass", 310, "metric")).toEqual({ qty: 325, unit: "g" });
    expect(display("mass", 37, "metric")).toEqual({ qty: 40, unit: "g" });
    expect(display("mass", 1250, "metric")).toEqual({ qty: 1.25, unit: "kg" });
  });
  it("spoons: nearest ¼, never below ¼, tbsp from 3 tsp", () => {
    expect(display("spoon", 0.8, "metric")).toEqual({ qty: 0.75, unit: "tsp" });
    expect(display("spoon", 0.05, "metric")).toEqual({ qty: 0.25, unit: "tsp" });
    expect(display("spoon", 6, "us")).toEqual({ qty: 2, unit: "tbsp" });
  });
  it("US: 200 g → 7.5 oz, 1 kg → 2.25 lb, 100 ml → 3.5 fl oz, 600 ml → 2.5 cups", () => {
    expect(display("mass", 200, "us")).toEqual({ qty: 7.5, unit: "oz" });
    expect(display("mass", 1000, "us")).toEqual({ qty: 2.25, unit: "lb" });
    expect(display("volume", 100, "us")).toEqual({ qty: 3.5, unit: "fl oz" });
    expect(display("volume", 600, "us")).toEqual({ qty: 2.5, unit: "cup" });
  });
});

describe("item states (PRD › Recompute and checks)", () => {
  const lines = buildLines([meal("b", "x", "tacos", 4), meal("c", "x", "salad", 2)], recipes, "metric");
  it("shows +100 g more when 150 g was bought but 250 g is now needed", () => {
    const r = applyStates(lines, [{ key: "feta_mass", checked: true, boughtQty: 150 }], "metric");
    expect(r.rows.find((x) => x.line.key === "feta_mass")!.state).toEqual({ kind: "needsMore", more: { qty: 100, unit: "g" } });
  });
  it("in cart, have it, couldn't get, and bought-but-no-longer-needed", () => {
    const r = applyStates(lines, [
      { key: "beans_count-can", checked: true },
      { key: "salt_taste", checked: false, haveIt: true },
      { key: "feta_mass", checked: false, unavailable: true },
      { key: "chicken_mass", checked: true, boughtQty: 1000 },
      { key: "extra_paper", checked: true },
    ], "metric");
    const state = (k: string) => r.rows.find((x) => x.line.key === k)!.state.kind;
    expect(state("beans_count-can")).toBe("inCart");
    expect(state("salt_taste")).toBe("haveIt");
    expect(state("feta_mass")).toBe("unavailable");
    expect(r.noLongerNeeded.map((s) => s.key)).toEqual(["chicken_mass"]);
  });
});

describe("per-meal-ingredient states (one list: state lives on the meal, not the line)", () => {
  // Feta: tacos meal "b" needs 150 g, salad meal "c" needs 100 g — one combined 250 g line.
  const lines = buildLines([meal("b", "x", "tacos", 4), meal("c", "x", "salad", 2)], recipes, "metric");
  const row = (r: ReturnType<typeof applySourceStates>, k: string) => r.rows.find((x) => x.line.key === k)!;
  it("buying one meal's share leaves the other still to buy (+100 g more)", () => {
    const r = applySourceStates(lines, [{ mealId: "b", key: "feta_mass", checked: true }], "metric");
    expect(row(r, "feta_mass").state).toEqual({ kind: "needsMore", more: { qty: 100, unit: "g" } });
    expect(row(r, "feta_mass").line.shown).toEqual({ qty: 250, unit: "g" });
  });
  it("buying both shares puts the line in the cart", () => {
    const r = applySourceStates(lines, [
      { mealId: "b", key: "feta_mass", checked: true },
      { mealId: "c", key: "feta_mass", checked: true },
    ], "metric");
    expect(row(r, "feta_mass").state).toEqual({ kind: "inCart" });
  });
  it("a partial boughtQty counts against the line total", () => {
    const r = applySourceStates(lines, [
      { mealId: "b", key: "feta_mass", checked: true, boughtQty: 50 },
      { mealId: "c", key: "feta_mass", checked: true, boughtQty: 100 },
    ], "metric");
    expect(row(r, "feta_mass").state).toEqual({ kind: "needsMore", more: { qty: 100, unit: "g" } });
  });
  it("have-it on one meal's share shrinks the line to the other meal's share", () => {
    const r = applySourceStates(lines, [{ mealId: "b", key: "feta_mass", checked: false, haveIt: true }], "metric");
    expect(row(r, "feta_mass").state).toEqual({ kind: "todo" });
    expect(row(r, "feta_mass").line.shown).toEqual({ qty: 100, unit: "g" });
  });
  it("have-it on every share hides the line under Have it", () => {
    const r = applySourceStates(lines, [
      { mealId: "b", key: "feta_mass", checked: false, haveIt: true },
      { mealId: "c", key: "feta_mass", checked: false, haveIt: true },
    ], "metric");
    expect(row(r, "feta_mass").state).toEqual({ kind: "haveIt" });
  });
  it("cleared shares hide the line; a cleared share plus a live one shows only the live share", () => {
    const cleared = applySourceStates(lines, [
      { mealId: "b", key: "feta_mass", checked: true, cleared: true },
      { mealId: "c", key: "feta_mass", checked: true, cleared: true },
    ], "metric");
    expect(cleared.rows.some((x) => x.line.key === "feta_mass")).toBe(false);
    const half = applySourceStates(lines, [
      { mealId: "b", key: "feta_mass", checked: true, cleared: true },
    ], "metric");
    expect(row(half, "feta_mass").state).toEqual({ kind: "todo" });
    expect(row(half, "feta_mass").line.shown).toEqual({ qty: 100, unit: "g" });
  });
  it("states for meals not on the list are ignored, and extra keys never become rows", () => {
    const r = applySourceStates(lines, [
      { mealId: "zzz", key: "feta_mass", checked: true },
      { mealId: "b", key: "extra_paper", checked: true },
    ], "metric");
    expect(row(r, "feta_mass").state).toEqual({ kind: "todo" });
    expect(r.noLongerNeeded).toEqual([]);
  });
  it("to-taste lines check off with no amount", () => {
    const r = applySourceStates(lines, [{ mealId: "b", key: "salt_taste", checked: true }], "metric");
    expect(row(r, "salt_taste").state).toEqual({ kind: "inCart" });
  });
});
