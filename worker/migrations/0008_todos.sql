-- Haven v1 · migration 0008 · To-dos module (PRD › To-dos plan, decisions Nov 2026) and push notifications.

-- Synced, household-scoped (written through the household's sync object like Meals).
CREATE TABLE todos_lists (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  emoji         TEXT,
  position      REAL NOT NULL DEFAULT 0,
  checklist     INTEGER NOT NULL DEFAULT 0,     -- 1 = reusable checklist (ticked items stay; Uncheck all)
  created_by    TEXT,
  version       INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    INTEGER
);
CREATE INDEX todos_lists_sync ON todos_lists (household_id, version);

CREATE TABLE todos_items (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  list_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  note          TEXT,
  due_date      TEXT,                           -- YYYY-MM-DD in the household's time zone
  due_time      TEXT,                           -- HH:MM, only with a due_date
  repeat        TEXT,                           -- JSON { kind, n? } or NULL
  assignee_id   TEXT,
  position      REAL NOT NULL DEFAULT 0,
  checked       INTEGER NOT NULL DEFAULT 0,     -- reusable checklists only
  done_at       INTEGER,                        -- one-time items on to-do lists
  done_by       TEXT,
  last_done_at  INTEGER,                        -- repeating items
  last_done_by  TEXT,
  created_by    TEXT,
  created_at    INTEGER,
  version       INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    INTEGER
);
CREATE INDEX todos_items_sync ON todos_items (household_id, version);
CREATE INDEX todos_items_due ON todos_items (household_id, due_date) WHERE deleted = 0;

-- Per person, per list: "Remind me" off. Synced so every device of that person agrees.
CREATE TABLE todos_mutes (
  id            TEXT PRIMARY KEY,               -- "<user_id>|<list_id>"
  household_id  TEXT NOT NULL REFERENCES households (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL,
  list_id       TEXT NOT NULL,
  version       INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    INTEGER
);
CREATE INDEX todos_mutes_sync ON todos_mutes (household_id, version);

-- Server only. One row per device that allowed notifications.
CREATE TABLE push_subscriptions (
  endpoint      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_ok_at    INTEGER
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

-- Server only. Per-person notification choices (each device's on/off is its subscription).
CREATE TABLE notify_prefs (
  user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  digest        INTEGER NOT NULL DEFAULT 1,     -- 10:00 morning digest
  given         INTEGER NOT NULL DEFAULT 1      -- "Mira gave you …"
);

-- Server only. Reminders already sent, so none is ever sent twice.
CREATE TABLE todos_sent (
  household_id  TEXT NOT NULL,
  key           TEXT NOT NULL,                  -- "item|<id>|<date>|<time>" or "digest|<date>"
  at            INTEGER NOT NULL,
  PRIMARY KEY (household_id, key)
);

-- Module switches: the admin's emergency switch (off until you turn it on), and per household.
INSERT INTO flags (key, value, updated_at) VALUES ('module_todos_enabled', 'false', 0);
