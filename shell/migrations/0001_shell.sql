-- 0001_shell.sql — Haven shell tables (spec §8–9). Batch 0.
-- Unprefixed tables belong to the shell; module tables carry their prefix
-- and live under that module's migrations folder.
-- Field lists are indicative per the spec; the entity boundaries, the prefix
-- rule and the derived-versus-stored rules are the decisions.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- No password column: Haven stores no passwords (Google-only login, Batch 2).

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, -- token hash only (Don't Ngiao precedent); never the raw token
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL, -- 90 days from last use, sliding (Batch 2)
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES users(id),
  invite_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS household_members (
  household_id TEXT NOT NULL REFERENCES households(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (household_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_household_members_user_id ON household_members(user_id);

-- Module registry: the home screen and router render from this table.
CREATE TABLE IF NOT EXISTS modules (
  module_id TEXT PRIMARY KEY, -- stable string, e.g. 'kitchen'
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  route_prefix TEXT NOT NULL,
  widget_priority INTEGER, -- NULL means no widget
  enabled INTEGER NOT NULL DEFAULT 1,
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Seed the registry with Kitchen (module 1). Disabling a module hides its
-- tile and widget and unmounts its routes, without deleting its tables.
INSERT INTO modules (module_id, name, icon, route_prefix, widget_priority, enabled)
VALUES ('kitchen', 'Kitchen', 'kitchen', '/kitchen/', 1, 1);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL,
  keys TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, endpoint)
);
-- A row is the opt-in: turning notifications off deletes the row, and a
-- 404 / 410 response on send deletes a dead subscription (Batch 7).

-- Shell-owned, append-only cross-module handoff log (spec §9–10).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic; ordering by insertion
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  type TEXT NOT NULL, -- namespaced, e.g. 'kitchen.week_planned'
  source_module TEXT NOT NULL,
  household_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload TEXT NOT NULL, -- JSON, self-contained
  consumed_by TEXT, -- per-subscription delivery bookkeeping
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_household_id ON events(household_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
