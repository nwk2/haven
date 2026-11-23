-- Haven v1 · migration 0007 · announcements: typed, titled, dismissible (decision, Nov 2026).
-- Several can be live at once; the console stacks them (most urgent first). A dismissal is per
-- person and per announcement, so it holds on every device and never comes back.

ALTER TABLE announcements ADD COLUMN kind TEXT NOT NULL DEFAULT 'info' CHECK (kind IN ('info', 'warn', 'ok'));
ALTER TABLE announcements ADD COLUMN title TEXT;
ALTER TABLE announcements ADD COLUMN dismissible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE announcements ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;

CREATE TABLE announcement_dismissals (
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  announcement_id TEXT NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  at              INTEGER NOT NULL,
  PRIMARY KEY (user_id, announcement_id)
);
