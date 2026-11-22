// Migration 0006 must give every planned meal the run the old rule covered it with:
// latest regular run on or before the meal; it covers until the day before the next regular run,
// and the last run covers 14 days (its date + 13). Random households, real migrations, SQLite.
// Run: node --no-warnings test/migration-0006.test.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
const before = files.filter((f) => f < "0006"), m6 = files.find((f) => f.startsWith("0006"));
const day = (n) => new Date(Date.UTC(2026, 10, 1) + n * 86_400_000).toISOString().slice(0, 10);
// mulberry32: a small generator whose low bits are well mixed (rand % n stays uniform).
let seed = 6006;
const rnd = (n) => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) % n); };
let gapCases = 0;   // meals more than 13 days after their run, covered because a later run exists

/** The pre-0006 rule (meals-core shoppingWindows + assignMeals), restated. */
function oldRule(runs, meal) {
  const regular = runs.filter((r) => r.kind === "regular" && !r.deleted).sort((a, b) => a.date.localeCompare(b.date));
  const i = regular.map((r) => r.date <= meal.date).lastIndexOf(true);
  if (i < 0) return null;
  const to = i + 1 < regular.length ? day(dayNum(regular[i + 1].date) - 1) : day(dayNum(regular[i].date) + 13);
  return meal.date <= to ? regular[i].id : null;
}
const dayNum = (d) => Math.round((Date.parse(d + "T00:00:00Z") - Date.UTC(2026, 10, 1)) / 86_400_000);

let checked = 0;
for (let h = 0; h < 500; h++) {
  const db = new DatabaseSync(":memory:");
  for (const f of before) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  db.exec("INSERT INTO users (id, google_sub, email, name, created_at) VALUES ('u','g','e','n',0); INSERT INTO households (id, name, owner_id, timezone, created_at) VALUES ('h','H','u','UTC',0);");
  const runs = []; const used = new Set();
  const nRuns = rnd(5);
  for (let r = 0; r < nRuns; r++) {
    let d; do d = day(rnd(60)); while (used.has(d)); used.add(d);
    const run = { id: `r${r}`, date: d, kind: rnd(6) === 0 ? "topup" : "regular", deleted: rnd(8) === 0 ? 1 : 0 };
    runs.push(run);
    db.prepare("INSERT INTO meals_trips (id, household_id, date, kind, status, version, deleted) VALUES (?, 'h', ?, ?, 'upcoming', 1, ?)").run(run.id, run.date, run.kind, run.deleted);
  }
  const meals = [];
  for (let k = 0; k < 8; k++) {
    const meal = { id: `m${k}`, date: day(rnd(75)), status: rnd(10) === 0 ? "skipped" : "planned" };
    meals.push(meal);
    db.prepare("INSERT INTO meals_planned (id, household_id, date, slot, recipe_id, servings, status, version) VALUES (?, 'h', ?, 'dinner', 'x', 2, ?, 5)").run(meal.id, meal.date, meal.status);
  }
  db.exec(readFileSync(new URL(`../migrations/${m6}`, import.meta.url), "utf8"));
  for (const meal of meals) {
    const row = db.prepare("SELECT run_id, version FROM meals_planned WHERE id = ?").get(meal.id);
    const want = meal.status === "planned" ? oldRule(runs, meal) : null;
    if (want && dayNum(meal.date) - dayNum(runs.find((r) => r.id === want).date) > 13) gapCases++;
    assert.equal(row.run_id, want, `household ${h}: ${meal.id} on ${meal.date}, runs ${JSON.stringify(runs)}`);
    assert.equal(row.version, want ? 1000005 : 5, `household ${h}: version bump only when assigned`);
    checked++;
  }
}
assert.ok(gapCases >= 20, `only ${gapCases} long-gap cases were generated; the test would not catch a 13-day cap`);
console.log(`migration-0006: ${checked} meals in 500 random households match the old rule (${gapCases} long-gap cases)`);
