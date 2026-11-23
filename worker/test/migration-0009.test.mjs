// Migration 0009 must carry every live run state onto the meals that run bought for:
//   have-it → every source meal's share; checked with no bought_qty → every source meal's
//   share; checked with a bought_qty → the earliest source meal's share, carrying the whole
//   bought amount; unchecked / couldn't-get → nothing. Extras carry over 1:1.
// Random households, real migrations, SQLite.
// Run: node --no-warnings test/migration-0009.test.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

const files = readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort();
const before = files.filter((f) => f < "0009"), m9 = files.find((f) => f.startsWith("0009"));
const day = (n) => new Date(Date.UTC(2026, 10, 1) + n * 86_400_000).toISOString().slice(0, 10);
// mulberry32: a small generator whose low bits are well mixed (rand % n stays uniform).
let seed = 9009;
const rnd = (n) => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) % n); };
const KEYS = ["feta_mass", "beans_count-can", "salt_taste", "garlic_count-clove"];
const SLOTS = ["breakfast", "lunch", "dinner", "snack"];

/** The meals a run's list was built from (the old listFor rule, restated). */
function sources(meals, tripId) {
  return meals.filter((m) => !m.deleted && m.status === "planned" && m.run_id === tripId && (!m.bought_on_trip_id || m.bought_on_trip_id === tripId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot) || a.id.localeCompare(b.id));
}

/** Expected meals_list_states rows for one old meals_items row, per the migration's rules. */
function expected(item, meals) {
  if (item.key.startsWith("extra_")) {
    return [{ id: item.key, meal_id: null, key: item.key, checked: item.checked, have_it: 0, bought_qty: null, label: item.label, qty: item.qty, unit: item.unit, section: item.section, version: item.version + 1000000 }];
  }
  const src = sources(meals, item.trip_id);
  if (item.have_it) return src.map((m) => ({ id: `${m.id}|${item.key}`, meal_id: m.id, key: item.key, checked: item.checked, have_it: 1, bought_qty: null, version: item.version + 1000000 }));
  if (!item.checked) return [];
  if (item.bought_qty == null) return src.map((m) => ({ id: `${m.id}|${item.key}`, meal_id: m.id, key: item.key, checked: 1, have_it: 0, bought_qty: null, version: item.version + 1000000 }));
  if (!src.length) return [];
  const first = src[0];
  return [{ id: `${first.id}|${item.key}`, meal_id: first.id, key: item.key, checked: 1, have_it: 0, bought_qty: item.bought_qty, version: item.version + 1000000 }];
}

let checked = 0, partial = 0, haveIt = 0, extras = 0;
for (let h = 0; h < 300; h++) {
  const db = new DatabaseSync(":memory:");
  for (const f of before) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  db.exec("INSERT INTO users (id, google_sub, email, name, created_at) VALUES ('u','g','e','n',0); INSERT INTO households (id, name, owner_id, timezone, created_at) VALUES ('h','H','u','UTC',0);");
  const trips = [];
  for (let r = 0; r < rnd(5); r++) {
    const t = { id: `r${r}`, date: day(rnd(60)), status: rnd(4) === 0 ? "finished" : "upcoming", deleted: rnd(8) === 0 ? 1 : 0 };
    trips.push(t);
    db.prepare("INSERT INTO meals_trips (id, household_id, date, status, version, deleted) VALUES (?, 'h', ?, ?, 1, ?)").run(t.id, t.date, t.status, t.deleted);
  }
  const meals = [];
  for (let k = 0; k < 8; k++) {
    const trip = trips[rnd(trips.length + 1)];   // sometimes no run at all
    const m = { id: `m${k}`, date: day(rnd(75)), slot: SLOTS[rnd(4)], status: rnd(10) === 0 ? "skipped" : "planned",
      run_id: trip?.id ?? null, bought_on_trip_id: rnd(6) === 0 && trips.length ? trips[rnd(trips.length)].id : null, deleted: rnd(12) === 0 ? 1 : 0 };
    meals.push(m);
    db.prepare("INSERT INTO meals_planned (id, household_id, date, slot, recipe_id, servings, status, run_id, bought_on_trip_id, version, deleted) VALUES (?, 'h', ?, ?, 'x', 2, ?, ?, ?, 5, ?)")
      .run(m.id, m.date, m.slot, m.status, m.run_id, m.bought_on_trip_id, m.deleted);
  }
  const items = [];
  for (const t of trips) {
    for (const key of KEYS) {
      if (rnd(2)) continue;
      const bought = rnd(3);
      const item = { trip_id: t.id, key, checked: rnd(2), have_it: rnd(6) === 0 ? 1 : 0, unavailable: rnd(6) === 0 ? 1 : 0,
        bought_qty: bought === 0 ? null : bought === 1 ? 150 : 50, version: 10 + rnd(90), deleted: rnd(10) === 0 ? 1 : 0 };
      items.push(item);
      db.prepare("INSERT INTO meals_items (household_id, trip_id, key, checked, have_it, unavailable, bought_qty, version, deleted) VALUES ('h', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(item.trip_id, item.key, item.checked, item.have_it, item.unavailable, item.bought_qty, item.version, item.deleted);
    }
    if (rnd(2)) {
      const item = { trip_id: t.id, key: `extra_e${h}-${t.id}`, checked: rnd(2), have_it: 0, unavailable: 0, bought_qty: null,
        label: "Paper towels", qty: 2, unit: "pack", section: "other", version: 10 + rnd(90), deleted: rnd(10) === 0 ? 1 : 0 };
      items.push(item);
      db.prepare("INSERT INTO meals_items (household_id, trip_id, key, checked, label, qty, unit, section, version, deleted) VALUES ('h', ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(item.trip_id, item.key, item.checked, item.label, item.qty, item.unit, item.section, item.version, item.deleted);
    }
  }
  db.exec(readFileSync(new URL(`../migrations/${m9}`, import.meta.url), "utf8"));

  // The new tables exist with the right shape.
  const cols = db.prepare("PRAGMA table_info(admin_signin_codes)").all().map((c) => c.name);
  assert.deepEqual(cols, ["code_hash", "created_at", "expires_at", "used_at"], `household ${h}: admin_signin_codes columns`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_signin_codes").get().n, 0, `household ${h}: no codes seeded`);

  const want = [];
  for (const item of items.filter((i) => !i.deleted)) want.push(...expected(item, meals));
  const got = db.prepare("SELECT id, meal_id, key, checked, have_it, bought_qty, label, qty, unit, section, cleared, version FROM meals_list_states ORDER BY id").all();
  const norm = (r) => ({ id: r.id, meal_id: r.meal_id ?? null, key: r.key, checked: r.checked, have_it: r.have_it,
    bought_qty: r.bought_qty ?? null, label: r.label ?? null, qty: r.qty ?? null, unit: r.unit ?? null, section: r.section ?? null,
    cleared: r.cleared, version: r.version });
  const wantFull = want.map((w) => ({ ...w, label: w.label ?? null, qty: w.qty ?? null, unit: w.unit ?? null, section: w.section ?? null, cleared: 0 })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(got.map(norm), wantFull, `household ${h}: backfilled rows`);
  for (const r of got) assert.equal(r.cleared, 0, `household ${h}: nothing starts cleared`);
  for (const item of items.filter((i) => !i.deleted && i.checked && i.bought_qty != null && !i.key.startsWith("extra_"))) partial++;
  for (const item of items.filter((i) => !i.deleted && i.have_it)) haveIt++;
  for (const item of items.filter((i) => !i.deleted && i.key.startsWith("extra_"))) extras++;
  checked += want.length;
}
assert.ok(partial >= 20, `only ${partial} partial-buy cases were generated; the test would not catch the earliest-share rule`);
assert.ok(haveIt >= 20, `only ${haveIt} have-it cases were generated`);
assert.ok(extras >= 20, `only ${extras} extras were generated`);
console.log(`migration-0009: ${checked} backfilled rows in 300 random households match the rules (${partial} partial, ${haveIt} have-it, ${extras} extras)`);
