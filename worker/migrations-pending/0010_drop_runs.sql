-- Haven v1 · migration 0010 · drop the run tables.
-- DO NOT APPLY until the one-list code (migration 0009) is deployed AND verified live.
-- This file lives in worker/migrations-pending (not worker/migrations) so that
-- `wrangler d1 migrations apply` cannot pick it up early; on landing day it moves into
-- worker/migrations and is applied once, after the new code is confirmed live.
-- The code no longer reads or writes these tables (purge.ts dropped them from its
-- tombstone list in the same deploy), so dropping them only removes dead data.
-- No household loses anything: 0009 already copied every live state into
-- meals_list_states, and extras carried over 1:1.

DROP INDEX IF EXISTS meals_planned_run;   -- created by 0006 on the column being dropped
DROP TABLE meals_trips;
DROP TABLE meals_items;
ALTER TABLE meals_planned DROP COLUMN run_id;
ALTER TABLE meals_planned DROP COLUMN bought_on_trip_id;
