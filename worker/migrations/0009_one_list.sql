-- Haven v1 · migration 0009 · the one shopping list + admin sign-in codes (decision, Nov 2026).
-- The run model is gone: list state now lives on the meal-ingredient (meals_list_states),
-- and extras are free-standing rows in the same table. The old tables stay until migration
-- 0010, which drops them after the new code is live and verified.
--
-- Backfill: every live item state on a run maps onto the meals that run bought for
-- (same meal set listFor used: run_id = trip, planned, not bought on another run).
--   have-it → every source meal's share (it means "we have it at home for these meals")
--   checked, bought_qty NULL → every source meal's share (NULL meant the whole line)
--   checked, bought_qty set → the earliest source meal's share, carrying the whole bought
--     amount (the list shows the line total, so the total is preserved exactly; a later
--     meal on the same line shows as still to buy)
--   unchecked / couldn't-get → nothing (still to buy)
-- Extras carry over 1:1. Versions jump +1,000,000 so every phone downloads the change
-- (same as 0006); the household's sync object catches its counter up on next use.

CREATE TABLE meals_list_states (
  id            TEXT PRIMARY KEY,   -- meal_id || '|' || key, or extra_<uuid> for extras
  household_id  TEXT NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  meal_id       TEXT,
  key           TEXT NOT NULL,      -- ingredientId_family, or extra_<uuid>
  checked       INTEGER NOT NULL DEFAULT 0,
  checked_by    TEXT,
  checked_at    INTEGER,
  bought_qty    REAL,               -- base units, for this meal's share; NULL = the meal's full share
  have_it       INTEGER NOT NULL DEFAULT 0,
  cleared       INTEGER NOT NULL DEFAULT 0,  -- bought, then hidden by "Clear bought"
  label         TEXT,               -- extras only
  qty           REAL,               -- extras only
  unit          TEXT,               -- extras only
  section       TEXT,               -- extras only
  version       INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    INTEGER
);
CREATE INDEX meals_list_states_sync ON meals_list_states (household_id, version);
CREATE INDEX meals_list_states_meal ON meals_list_states (household_id, meal_id);

CREATE TABLE admin_signin_codes (
  code_hash   TEXT PRIMARY KEY,     -- SHA-256 (base64url) of the code, upper-cased, punctuation stripped
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,     -- created_at + 10 minutes
  used_at     INTEGER               -- set on redemption (single use) or when a newer code retires it
);
CREATE INDEX admin_signin_codes_expiry ON admin_signin_codes (expires_at);

WITH sources AS (
  SELECT i.household_id AS household_id, i.key AS key,
         i.checked AS checked, i.checked_by AS checked_by, i.checked_at AS checked_at,
         i.bought_qty AS bought_qty, i.have_it AS have_it, i.version AS version,
         m.id AS meal_id,
         ROW_NUMBER() OVER (PARTITION BY i.trip_id, i.key ORDER BY m.date, m.slot, m.id) AS rn
  FROM meals_items i
  JOIN meals_planned m ON m.household_id = i.household_id
    AND m.run_id = i.trip_id AND m.status = 'planned' AND m.deleted = 0
    AND (m.bought_on_trip_id IS NULL OR m.bought_on_trip_id = i.trip_id)
  WHERE i.deleted = 0 AND substr(i.key, 1, 6) <> 'extra_'
)
INSERT INTO meals_list_states (id, household_id, meal_id, key, checked, checked_by, checked_at, bought_qty, have_it, cleared, version, deleted)
SELECT meal_id || '|' || key, household_id, meal_id, key,
       checked, checked_by, checked_at,
       CASE WHEN have_it = 1 OR bought_qty IS NULL THEN NULL ELSE bought_qty END,
       have_it, 0, version + 1000000, 0
FROM sources
WHERE have_it = 1 OR (checked = 1 AND (bought_qty IS NULL OR rn = 1));

INSERT INTO meals_list_states (id, household_id, meal_id, key, checked, checked_by, checked_at, label, qty, unit, section, version, deleted)
SELECT i.key, i.household_id, NULL, i.key, i.checked, i.checked_by, i.checked_at, i.label, i.qty, i.unit, i.section, i.version + 1000000, 0
FROM meals_items i
WHERE i.deleted = 0 AND substr(i.key, 1, 6) = 'extra_';
