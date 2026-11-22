/**
 * Smart ingredient field (PRD › Recipe editor rules): one line such as
 * "2 cans black beans, drained" → amount, unit, name, note.
 */
export interface ParsedLine { qty?: number; unit?: string; name: string; note?: string; optional?: boolean; toTaste?: boolean; unread?: boolean }

const UNIT_WORDS: Record<string, string> = {
  g: "g", gram: "g", grams: "g", gr: "g",
  kg: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  oz: "oz", ounce: "oz", ounces: "oz",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
  ml: "ml", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml",
  l: "l", litre: "l", litres: "l", liter: "l", liters: "l",
  cup: "cup", cups: "cup",
  tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tbs: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  floz: "floz",
  can: "can", cans: "can", tin: "can", tins: "can",
  pack: "pack", packs: "pack", packet: "pack", packets: "pack",
  clove: "clove", cloves: "clove", bunch: "bunch", bunches: "bunch",
  slice: "slice", slices: "slice", pinch: "pinch", pinches: "pinch", whole: "whole",
};
const VULGAR: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };

function readNumber(tokens: string[]): { qty?: number; used: number } {
  const one = (t: string): number | undefined => {
    if (VULGAR[t] != null) return VULGAR[t];
    const mixed = t.match(/^(\d+)([½¼¾⅓⅔⅛])$/); if (mixed) return +mixed[1] + VULGAR[mixed[2]];
    const frac = t.match(/^(\d+)\/(\d+)$/); if (frac && +frac[2] > 0) return +frac[1] / +frac[2];
    const range = t.match(/^(\d+(?:[.,]\d+)?)[-–](\d+(?:[.,]\d+)?)$/); if (range) return +range[2].replace(",", ".");   // shop for the upper end
    if (/^\d+(?:[.,]\d+)?$/.test(t)) return +t.replace(",", ".");
    return undefined;
  };
  const a = tokens[0] != null ? one(tokens[0]) : undefined;
  if (a == null) return { used: 0 };
  const b = tokens[1] != null ? one(tokens[1]) : undefined;
  if (b != null && b < 1 && Number.isInteger(a)) return { qty: a + b, used: 2 };       // "1 1/2", "1 ½"
  return { qty: a, used: 1 };
}

export function parseLine(input: string): ParsedLine {
  let text = input.trim().replace(/\s+/g, " ");
  const out: Partial<ParsedLine> = {};
  if (/\(optional\)|,\s*optional\b/i.test(text)) { out.optional = true; text = text.replace(/\s*\(optional\)|,\s*optional\b/gi, ""); }
  if (/\b(to taste)\b/i.test(text)) { out.toTaste = true; text = text.replace(/,?\s*to taste\b/i, ""); }
  text = text.replace(/fl\.? oz/gi, "floz").replace(/^(\d+(?:[.,]\d+)?)([a-z]+)\b/i, "$1 $2");   // "200g" → "200 g"
  const [main, ...noteParts] = text.split(",");
  const tokens = main.trim().split(" ").filter(Boolean);
  const { qty, used } = readNumber(tokens);
  let rest = tokens.slice(used);
  let unit: string | undefined;
  if (qty != null && rest.length > 1 && UNIT_WORDS[rest[0].toLowerCase().replace(/\.$/, "")]) {
    unit = UNIT_WORDS[rest[0].toLowerCase().replace(/\.$/, "")];
    rest = rest.slice(1);
    if (rest[0]?.toLowerCase() === "of") rest = rest.slice(1);
  }
  const name = rest.join(" ").trim();
  const note = noteParts.join(",").trim() || undefined;
  if (out.toTaste) return { name: name || main.trim(), note, toTaste: true, optional: out.optional };
  if (qty == null) return { name: main.trim(), note, optional: out.optional, unread: true };
  return { qty, unit: unit ?? "whole", name, note, optional: out.optional };
}

/** Paste a list: one ingredient per line; blank lines and bullets ignored. */
export const parseList = (text: string): ParsedLine[] =>
  text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "")).filter((l) => l.trim()).map(parseLine);
