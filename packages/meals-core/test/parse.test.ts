import { describe, expect, it } from "vitest";
import { parseLine, parseList } from "../src";

describe("smart ingredient field (PRD › Recipe editor rules)", () => {
  it.each([
    ["2 cans black beans, drained", { qty: 2, unit: "can", name: "black beans", note: "drained" }],
    ["1 can kidney beans, rinsed", { qty: 1, unit: "can", name: "kidney beans", note: "rinsed" }],
    ["150 g feta, crumbled", { qty: 150, unit: "g", name: "feta", note: "crumbled" }],
    ["200g cherry tomatoes", { qty: 200, unit: "g", name: "cherry tomatoes" }],
    ["1 1/2 cups flour", { qty: 1.5, unit: "cup", name: "flour" }],
    ["1 ½ tbsp olive oil", { qty: 1.5, unit: "tbsp", name: "olive oil" }],
    ["½ tsp chilli flakes (optional)", { qty: 0.5, unit: "tsp", name: "chilli flakes", optional: true }],
    ["2-3 garlic cloves", { qty: 3, unit: "whole", name: "garlic cloves" }],
    ["3 cloves garlic", { qty: 3, unit: "clove", name: "garlic" }],
    ["1 red onion, finely diced", { qty: 1, unit: "whole", name: "red onion", note: "finely diced" }],
    ["8 fl oz milk", { qty: 8, unit: "floz", name: "milk" }],
    ["2 cups of rice", { qty: 2, unit: "cup", name: "rice" }],
  ])("%s", (input, expected) => expect(parseLine(input)).toEqual(expected));

  it("to taste has no amount", () => expect(parseLine("Salt, to taste")).toEqual({ name: "Salt", toTaste: true }));
  it("lines without an amount are kept and flagged", () => expect(parseLine("Handful coriander")).toEqual({ name: "Handful coriander", unread: true }));
  it("a number alone with one word is a count, not a unit", () => expect(parseLine("1 lime")).toEqual({ qty: 1, unit: "whole", name: "lime" }));
  it("pastes a list, ignoring bullets and blank lines", () => {
    const r = parseList("- 1 lime\n\n• 200 g cherry tomatoes\n3. Handful coriander");
    expect(r.map((x) => x.name)).toEqual(["lime", "cherry tomatoes", "Handful coriander"]);
    expect(r[2].unread).toBe(true);
  });
});
