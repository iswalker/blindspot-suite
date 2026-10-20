// Turso (libSQL / SQLite) schema for persisted Blindspot Suite settings. This file is the source of
// truth -- the serverless functions run these statements (all idempotent) before first use, so a
// brand-new empty database needs no manual setup. db/schema.sql is generated from it
// (`node db/export-schema.js`) for reading and for `turso db shell <db> < db/schema.sql`.
//
// Scoping: everything hangs off (user_id, budget_id).
//   user_id   = the YNAB user id (GET /v1/user -> data.user.id, a stable UUID). The server derives it
//               by passing the caller's YNAB token through to YNAB; the token itself is never stored.
//   budget_id = the YNAB budget id (category / account ids are only unique within a budget).
// So a second person using the app gets their own rows without any schema change.
//
// What is wired up today: account_groups (Account Summary). The remaining tables model the "YNAB
// Config" Google Sheet so it can be migrated later: config_rows mirrors its columns 1:1,
// merchants/merchant_flags mirror the Merchants tab, settings holds free-form UI preferences.

var ACCOUNT_GROUPS = ['Cash', 'Credit', 'Savings', 'Investments', 'Loans', 'Kids', 'Vehicles', 'Real Estate', 'Other'];

var STATEMENTS = [
  // -- bookkeeping -------------------------------------------------------------------------------
  "CREATE TABLE IF NOT EXISTS schema_migrations (" +
  "  version    INTEGER PRIMARY KEY," +
  "  applied_at TEXT NOT NULL DEFAULT (datetime('now'))" +
  ")",

  "CREATE TABLE IF NOT EXISTS users (" +
  "  user_id      TEXT PRIMARY KEY," +                       // YNAB user id
  "  created_at   TEXT NOT NULL DEFAULT (datetime('now'))," +
  "  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))" +
  ")",

  // -- Account Summary (wired up) ----------------------------------------------------------------
  // The groups in display order. A table (not a CHECK) so custom groups / reordering can come
  // later without a migration of account_groups.
  "CREATE TABLE IF NOT EXISTS account_group_defs (" +
  "  group_name TEXT PRIMARY KEY," +
  "  sort_order INTEGER NOT NULL" +
  ")",
  "INSERT INTO account_group_defs (group_name, sort_order) VALUES " +
    ACCOUNT_GROUPS.map(function(g, i) { return "('" + g + "', " + (i + 1) + ")"; }).join(', ') +
    " ON CONFLICT(group_name) DO UPDATE SET sort_order = excluded.sort_order",

  // One row per account the user has assigned; unassigned accounts have no row (the UI lists them as Unassigned; Other is a real group).
  "CREATE TABLE IF NOT EXISTS account_groups (" +
  "  user_id    TEXT NOT NULL REFERENCES users(user_id)," +
  "  budget_id  TEXT NOT NULL," +
  "  account_id TEXT NOT NULL," +                            // YNAB account id
  "  group_name TEXT NOT NULL REFERENCES account_group_defs(group_name)," +
  "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))," +
  "  PRIMARY KEY (user_id, budget_id, account_id)" +
  ")",

  // Retired groups: their accounts move to the group that replaced them (idempotent).
  "UPDATE account_groups SET group_name = 'Real Estate' WHERE group_name = 'Mortgage'",
  "DELETE FROM account_group_defs WHERE group_name = 'Mortgage'",

  // -- "YNAB Config" sheet (not wired up yet) ----------------------------------------------------
  // One row per sheet row, in sheet order. Column names follow the sheet's header aliases:
  //   text <- "ID"/"Text"    type <- "Type"           metric <- "Used For"/"Metric"
  //   section <- "Section"/"Group"                    amount <- "Amount"/"Due Date" (kept as typed;
  //   unit <- "Unit"         multiplier <- "Transaction Multiplier"     the app derives $ vs days)
  //   date_range <- "Date Range"   assoc_category_ids <- "Associated Category ID(s)" (JSON array)
  //   track_against <- "Track Against"   past_value <- "Past Value"
  "CREATE TABLE IF NOT EXISTS config_rows (" +
  "  id                 INTEGER PRIMARY KEY AUTOINCREMENT," +
  "  user_id            TEXT NOT NULL REFERENCES users(user_id)," +
  "  budget_id          TEXT NOT NULL," +
  "  position           INTEGER NOT NULL," +
  "  text               TEXT NOT NULL DEFAULT ''," +
  "  type               TEXT NOT NULL DEFAULT ''," +
  "  metric             TEXT NOT NULL DEFAULT ''," +
  "  section            TEXT NOT NULL DEFAULT ''," +
  "  amount             TEXT NOT NULL DEFAULT ''," +
  "  unit               TEXT NOT NULL DEFAULT ''," +
  "  multiplier         REAL," +
  "  date_range         TEXT NOT NULL DEFAULT ''," +
  "  assoc_category_ids TEXT NOT NULL DEFAULT '[]'," +
  "  track_against      TEXT NOT NULL DEFAULT ''," +
  "  past_value         REAL NOT NULL DEFAULT 0," +
  "  created_at         TEXT NOT NULL DEFAULT (datetime('now'))," +
  "  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))" +
  ")",
  "CREATE INDEX IF NOT EXISTS idx_config_rows_scope  ON config_rows (user_id, budget_id, position)",
  "CREATE INDEX IF NOT EXISTS idx_config_rows_metric ON config_rows (user_id, budget_id, metric)",
  "CREATE INDEX IF NOT EXISTS idx_config_rows_type   ON config_rows (user_id, budget_id, type)",

  // "Merchants" tab: payee x metric matrix whose cells are yes / tbd.
  "CREATE TABLE IF NOT EXISTS merchants (" +
  "  user_id   TEXT NOT NULL REFERENCES users(user_id)," +
  "  budget_id TEXT NOT NULL," +
  "  payee_key TEXT NOT NULL," +                             // lower-cased payee, as the app matches it
  "  payee     TEXT NOT NULL," +                             // as typed
  "  PRIMARY KEY (user_id, budget_id, payee_key)" +
  ")",
  "CREATE TABLE IF NOT EXISTS merchant_flags (" +
  "  user_id   TEXT NOT NULL," +
  "  budget_id TEXT NOT NULL," +
  "  payee_key TEXT NOT NULL," +
  "  metric    TEXT NOT NULL," +                             // the column header
  "  value     TEXT NOT NULL CHECK (value IN ('yes', 'tbd'))," +
  "  PRIMARY KEY (user_id, budget_id, payee_key, metric)," +
  "  FOREIGN KEY (user_id, budget_id, payee_key) REFERENCES merchants (user_id, budget_id, payee_key) ON DELETE CASCADE" +
  ")",

  // Free-form per-budget preferences (e.g. the Net Worth Preview inputs) as JSON values.
  "CREATE TABLE IF NOT EXISTS settings (" +
  "  user_id    TEXT NOT NULL REFERENCES users(user_id)," +
  "  budget_id  TEXT NOT NULL," +
  "  key        TEXT NOT NULL," +
  "  value_json TEXT NOT NULL," +
  "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))," +
  "  PRIMARY KEY (user_id, budget_id, key)" +
  ")",

  "INSERT OR IGNORE INTO schema_migrations (version) VALUES (1)"
];

module.exports = { STATEMENTS: STATEMENTS, ACCOUNT_GROUPS: ACCOUNT_GROUPS };
