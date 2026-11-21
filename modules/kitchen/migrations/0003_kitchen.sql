-- 0003_kitchen.sql — Simplified Recipe + meal-grouped Shop (0.4.0).
--
-- Simplified Recipe: the per-step table is replaced by one free-text
-- instructions field on the recipe. Usual cook, cook time and notes are
-- dropped from the form and the API; their columns stay on cook_recipes
-- (unused) so no data is lost by this change. cook_recipe_steps is left
-- in place, unused — removing a table follows the remove-column rule
-- (code first, then drop) and is a later cleanup, not this change.
ALTER TABLE cook_recipes ADD COLUMN instructions TEXT;

-- Meal-grouped Shop (Haven spec v0.16 §9): one group per planned meal
-- slot. A group stores the fingerprint of the plan slot and the recipe
-- contents it was built from; staleness is derived by comparing that
-- fingerprint with a fresh derivation, never stored as a flag.
--
-- Note: the spec names the slot key plan_day_id, but cook_plan_days has
-- a composite primary key (plan_id, date, meal) and no single-column id,
-- so the slot is keyed here by (run_id, date, meal) — unique within a
-- run's week — with recipe_id alongside for the fingerprint. Field lists
-- in the spec are indicative (§8); the entity boundary (one group per
-- planned meal, fingerprint over slot + recipe contents) is as specified.
CREATE TABLE IF NOT EXISTS shop_list_groups (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  recipe_id TEXT,
  fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (run_id, date, meal)
);
CREATE INDEX IF NOT EXISTS idx_shop_list_groups_run
  ON shop_list_groups(run_id);

-- Combined lines: a line lives in its earliest contributing group
-- (group_id); covers names the other groups summed into it, as a JSON
-- array of group ids (nullable — null for uncombined lines). Free items
-- (manual adds, pantry-out lines, carry-overs) belong to no group
-- (group_id NULL) and render in the Free items group.
ALTER TABLE shop_list_items ADD COLUMN group_id TEXT;
ALTER TABLE shop_list_items ADD COLUMN covers TEXT;
