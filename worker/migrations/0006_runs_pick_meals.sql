-- Haven v1 · migration 0006 · grocery runs hold the meals you pick (decision, Nov 2026).
-- Before: a run covered every meal from its date until the day before the next run; the last run
-- covered 14 days (its date + 13). After: each planned meal names its run (meals_planned.run_id);
-- several runs can share a day and a run can have a name ("Market"). Existing plans keep exactly
-- what they had: the backfill below reproduces the old rule.

ALTER TABLE meals_planned ADD COLUMN run_id TEXT;
ALTER TABLE meals_trips ADD COLUMN name TEXT;
DROP INDEX IF EXISTS meals_trips_one_regular_per_day;
CREATE INDEX IF NOT EXISTS meals_planned_run ON meals_planned (household_id, run_id);

-- Old rule, exactly: the covering run is the latest regular run on or before the meal's date.
-- It covers the meal if another regular run comes later (the window runs to the day before it),
-- or, for the last run, if the meal is within 13 days of it. (One regular run per date was
-- enforced until now, so "latest on or before" is unambiguous.) Versions jump so every phone
-- downloads the change; the household's sync object catches its counter up on next use.
UPDATE meals_planned
SET run_id = (
      SELECT t.id FROM meals_trips t
      WHERE t.household_id = meals_planned.household_id AND t.kind = 'regular' AND t.deleted = 0
        AND t.date <= meals_planned.date
      ORDER BY t.date DESC LIMIT 1),
    version = version + 1000000
WHERE deleted = 0 AND status = 'planned' AND run_id IS NULL
  AND EXISTS (
      SELECT 1 FROM meals_trips t
      WHERE t.household_id = meals_planned.household_id AND t.kind = 'regular' AND t.deleted = 0
        AND t.date <= meals_planned.date
        AND (t.date >= date(meals_planned.date, '-13 days')
             OR EXISTS (SELECT 1 FROM meals_trips n
                        WHERE n.household_id = meals_planned.household_id AND n.kind = 'regular' AND n.deleted = 0
                          AND n.date > meals_planned.date))
        AND t.date = (SELECT MAX(t2.date) FROM meals_trips t2
                      WHERE t2.household_id = meals_planned.household_id AND t2.kind = 'regular' AND t2.deleted = 0
                        AND t2.date <= meals_planned.date));
