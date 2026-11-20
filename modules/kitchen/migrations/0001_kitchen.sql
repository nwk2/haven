-- 0001_kitchen.sql — Kitchen core (Batch 3): Recipes, Plan, Today.
-- Haven spec §9 (cook_* tables) + Cook Board spec §10. Household-scoped,
-- household_id leading the composite indexes (spec §8). Last-cooked and
-- times cooked are derived from cook_events, never stored.
--
-- shop_items (the canonical catalogue) lands here too, not in Batch 4:
-- recipe ingredients reference canonical items, never free text (Cook
-- Board §10), so the catalogue must exist before the first ingredient
-- row. Batch 4 builds the Shop list tables on top of it.
-- photo_size_bytes is carried on cook_recipes (Cook Board §10) so Batch 6
-- can enforce the 1 GB-per-household R2 cap from D1; photo upload itself
-- is Batch 6, not this batch.

CREATE TABLE IF NOT EXISTS cook_recipes (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  name TEXT NOT NULL,
  usual_cook_id TEXT,
  cook_minutes INTEGER,
  servings INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  photo_r2_key TEXT,
  photo_size_bytes INTEGER,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_cook_recipes_household
  ON cook_recipes(household_id, archived_at, name);

CREATE TABLE IF NOT EXISTS shop_items (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  default_unit TEXT,
  category TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (household_id, canonical_name, variant)
);
CREATE INDEX IF NOT EXISTS idx_shop_items_household
  ON shop_items(household_id, canonical_name);

CREATE TABLE IF NOT EXISTS cook_recipe_ingredients (
  recipe_id TEXT NOT NULL REFERENCES cook_recipes(id),
  item_id TEXT NOT NULL REFERENCES shop_items(id),
  quantity REAL,
  unit TEXT,
  prep_note TEXT,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (recipe_id, sort_order)
);
CREATE INDEX IF NOT EXISTS idx_cook_recipe_ingredients_item
  ON cook_recipe_ingredients(item_id);

CREATE TABLE IF NOT EXISTS cook_recipe_steps (
  recipe_id TEXT NOT NULL REFERENCES cook_recipes(id),
  step_no INTEGER NOT NULL,
  text TEXT NOT NULL,
  duration_minutes INTEGER,
  PRIMARY KEY (recipe_id, step_no)
);

CREATE TABLE IF NOT EXISTS cook_week_plans (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (household_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_cook_week_plans_household
  ON cook_week_plans(household_id, week_start);

-- One row per planned slot; no row if unplanned (spec §9). state is what
-- was PLANNED (recipe / eat_out / leftovers); resolution is what HAPPENED
-- (cooked / eat_out / leftovers / skipped; NULL = not recorded) and only
-- applies to recipe slots — a slot planned as eat_out or leftovers is
-- already decided and never needs resolving.
CREATE TABLE IF NOT EXISTS cook_plan_days (
  plan_id TEXT NOT NULL REFERENCES cook_week_plans(id),
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  state TEXT NOT NULL,
  recipe_id TEXT REFERENCES cook_recipes(id),
  servings INTEGER,
  source_date TEXT,
  source_meal TEXT,
  resolution TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  PRIMARY KEY (plan_id, date, meal)
);
CREATE INDEX IF NOT EXISTS idx_cook_plan_days_recipe
  ON cook_plan_days(recipe_id);

-- Rotation source of truth, written only when a slot resolves as Cooked
-- (spec §6, §9). Insert-only in normal use; a re-resolution away from
-- Cooked removes the event for that slot so last-cooked stays truthful.
-- rating: 1 thumbs up, -1 thumbs down, NULL none (Cook Board §8).
CREATE TABLE IF NOT EXISTS cook_events (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL REFERENCES cook_recipes(id),
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  cooked_by TEXT NOT NULL,
  rating INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_cook_events_household_recipe
  ON cook_events(household_id, recipe_id, date);
CREATE INDEX IF NOT EXISTS idx_cook_events_household_date
  ON cook_events(household_id, date);
