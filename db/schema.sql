-- Generated from lib/schema.js by db/export-schema.js -- edit that file, not this one.
-- Applying it by hand is optional (the API creates these tables on first use):
--   turso db shell <your-db> < db/schema.sql

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_group_defs (
  group_name TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL
);

INSERT INTO account_group_defs (group_name, sort_order) VALUES ('Cash', 1), ('Credit', 2), ('Savings', 3), ('Investments', 4), ('Loans', 5), ('Kids', 6), ('Vehicles', 7), ('Real Estate', 8), ('Mortgage', 9), ('Other', 10) ON CONFLICT(group_name) DO UPDATE SET sort_order = excluded.sort_order;

CREATE TABLE IF NOT EXISTS account_groups (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  budget_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  group_name TEXT NOT NULL REFERENCES account_group_defs(group_name),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, budget_id, account_id)
);

CREATE TABLE IF NOT EXISTS config_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id),
  budget_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL DEFAULT '',
  section TEXT NOT NULL DEFAULT '',
  amount TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  multiplier REAL,
  date_range TEXT NOT NULL DEFAULT '',
  assoc_category_ids TEXT NOT NULL DEFAULT '[]',
  track_against TEXT NOT NULL DEFAULT '',
  past_value REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_config_rows_scope ON config_rows (user_id, budget_id, position);

CREATE INDEX IF NOT EXISTS idx_config_rows_metric ON config_rows (user_id, budget_id, metric);

CREATE INDEX IF NOT EXISTS idx_config_rows_type ON config_rows (user_id, budget_id, type);

CREATE TABLE IF NOT EXISTS merchants (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  budget_id TEXT NOT NULL,
  payee_key TEXT NOT NULL,
  payee TEXT NOT NULL,
  PRIMARY KEY (user_id, budget_id, payee_key)
);

CREATE TABLE IF NOT EXISTS merchant_flags (
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  payee_key TEXT NOT NULL,
  metric TEXT NOT NULL,
  value TEXT NOT NULL CHECK (value IN ('yes', 'tbd')),
  PRIMARY KEY (user_id, budget_id, payee_key, metric),
  FOREIGN KEY (user_id, budget_id, payee_key) REFERENCES merchants (user_id, budget_id, payee_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL REFERENCES users(user_id),
  budget_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, budget_id, key)
);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
