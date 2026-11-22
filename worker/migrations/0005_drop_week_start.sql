-- Haven v1 · migration 0005 · Plan shows a sliding 7 days from today (decision, Nov 2026),
-- so the household's first day of the week is no longer used anywhere.
ALTER TABLE households DROP COLUMN week_start;
