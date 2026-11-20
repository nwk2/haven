-- 0002_kitchen.sql — Shop derivation + Pantry (Batch 4).
-- Haven spec §7, §9 + Cook Board spec §5, §6, §10.
--
-- shop_runs: one active run at a time (Cook Board Principle 3). A run is
-- the shopping list for one week: status 'draft' until the first item is
-- checked off in store ('shopping'), then 'finished'. plan_fingerprint
-- is a JSON string of the week's sorted slot tuples, stored at
-- generation; the Shop GET recomputes it from the current plan, and a
-- mismatch on a non-finished run means "plan changed after this list was
-- made" (banner + Regenerate). List edits never affect the fingerprint.
-- plan_id is NULL when the run was created for a week with no plan yet.
--
-- shop_list_items: the lines of a run. run_id is NOT in Haven §9's field
-- list, but the spec's field lists are explicitly indicative, and
-- finished-run lines must be retained (archived with the run as not
-- bought) — without run_id the active list and archived lines cannot be
-- distinguished, so it is added here. sources is the complete source
-- list for display (JSON array of {recipe_id, name, date, meal}); the
-- singular source_recipe_id / source_date hold the FIRST contributor,
-- per the Haven spec shape. is_rounded + unrounded_quantity flag lines
-- whose aggregated countable quantity was rounded UP at generation
-- (Option A scaling, §5); editing a quantity clears the flag — the
-- planner took ownership. carry_over is set at finish time for to-buy
-- lines the planner wants in the next run; the next generation consumes
-- the flags and clears them.
--
-- shop_purchases: written ONLY by Finish run (checked-but-not-bought
-- rule, Cook Board §6). A checked line becomes a purchase; a to-buy line
-- never does. unit_price is price/quantity rounded to 2dp when both are
-- known, so last-bought price history stays queryable per item.
--
-- shop_pantry_items: manual Have/Out toggle only, no quantities, no
-- auto-deduction (Haven §7). Out puts the item back on the Shop list;
-- Have removes that line. Deleting a pantry row does NOT touch the shop
-- list (the shopping need survives the tracking row).
--
-- NOT in this migration, deliberately: a standing-items list (Cook Board
-- §5 step 5) — the Haven spec has no standing-items source and its
-- source enum has no 'standing' value, so there is nothing to derive
-- from; and receipts (post-v1, no receipts table).

CREATE TABLE IF NOT EXISTS shop_runs (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  plan_id TEXT,
  week_start TEXT NOT NULL,
  store TEXT,
  run_date TEXT,
  status TEXT NOT NULL,
  plan_fingerprint TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shop_runs_household_status
  ON shop_runs(household_id, status);

CREATE TABLE IF NOT EXISTS shop_list_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  item_id TEXT,
  display_name TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  is_rounded INTEGER NOT NULL DEFAULT 0,
  unrounded_quantity REAL,
  category TEXT,
  state TEXT NOT NULL DEFAULT 'to_buy',
  source TEXT NOT NULL,
  source_recipe_id TEXT,
  source_date TEXT,
  sources TEXT,
  carry_over INTEGER NOT NULL DEFAULT 0,
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_shop_list_items_run
  ON shop_list_items(run_id);
CREATE INDEX IF NOT EXISTS idx_shop_list_items_household_state
  ON shop_list_items(household_id, state);

CREATE TABLE IF NOT EXISTS shop_purchases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  unit_price REAL,
  line_total REAL,
  bought_date TEXT NOT NULL,
  bought_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_shop_purchases_item_date
  ON shop_purchases(item_id, bought_date);

CREATE TABLE IF NOT EXISTS shop_pantry_items (
  household_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  on_hand TEXT NOT NULL,
  PRIMARY KEY (household_id, item_id)
);
