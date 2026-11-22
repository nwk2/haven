-- Haven v1 · migration 0004 · when rows were deleted, so tombstones can be purged after 30 days.
-- deleted_at is set by the server (household Durable Object) whenever a row's deleted flag changes.
-- households.purge_floor = highest version purged so far; devices behind it resync from scratch.

ALTER TABLE meals_ingredients ADD COLUMN deleted_at INTEGER;
ALTER TABLE meals_planned     ADD COLUMN deleted_at INTEGER;
ALTER TABLE meals_trips       ADD COLUMN deleted_at INTEGER;
ALTER TABLE meals_items       ADD COLUMN deleted_at INTEGER;
ALTER TABLE activity          ADD COLUMN deleted_at INTEGER;
ALTER TABLE households        ADD COLUMN purge_floor INTEGER NOT NULL DEFAULT 0;

-- Rows already deleted before this migration start their 30 days now.
UPDATE meals_ingredients SET deleted_at = unixepoch() * 1000 WHERE deleted = 1 AND deleted_at IS NULL;
UPDATE meals_planned     SET deleted_at = unixepoch() * 1000 WHERE deleted = 1 AND deleted_at IS NULL;
UPDATE meals_trips       SET deleted_at = unixepoch() * 1000 WHERE deleted = 1 AND deleted_at IS NULL;
UPDATE meals_items       SET deleted_at = unixepoch() * 1000 WHERE deleted = 1 AND deleted_at IS NULL;
UPDATE activity          SET deleted_at = unixepoch() * 1000 WHERE deleted = 1 AND deleted_at IS NULL;
UPDATE meals_recipes     SET deleted_at = unixepoch() * 1000 WHERE deleted = 1 AND deleted_at IS NULL;
