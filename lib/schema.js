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

  // -- YNAB sign-in sessions ---------------------------------------------------------------------
  // YNAB access tokens last 2 hours. The authorization-code flow also returns a refresh token, which is
  // kept here (AES-GCM encrypted with a key derived from YNAB_CLIENT_SECRET) so the browser can ask for
  // a new access token without sending the user back to YNAB. The browser only ever holds an opaque
  // random session id; we store its SHA-256, so a database leak alone yields neither.
  "CREATE TABLE IF NOT EXISTS ynab_sessions (" +
  "  session_hash      TEXT PRIMARY KEY," +                   // sha256 hex of the session id given to the browser
  "  user_id           TEXT NOT NULL," +                      // YNAB user id
  "  refresh_token_enc TEXT NOT NULL," +                      // base64(iv + AES-GCM ciphertext)
  "  created_at        TEXT NOT NULL DEFAULT (datetime('now'))," +
  "  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))" +
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

  // -- "YNAB Config" sheet (wired up area by area: Runway first) ---------------------------------
  // One row per sheet row, in sheet order, keeping the sheet's own columns so a row moves across 1:1.
  // Everything is stored as typed; the app derives meaning (dollars vs days, id lists) when it reads.
  //   metric <- "Metric"          type <- "Type"           text <- "Text"          section <- "Group"
  //   amount <- "Amount"          unit <- "Unit"           multiplier <- "Transaction Multiplier"
  //   track_against <- "Track Against"                      date_range <- "Date Range"
  //   assoc_category_ids <- "Associated Category ID(s)"     past_value <- "Past Value"
  //   notes <- "Notes"            old_account_ids <- "Old Account ID's"   old_category_ids <- "Old Category ID's"
  // `section` is the area a row belongs to ("Runway", "Net Worth", ...), which is how the app loads
  // and replaces one area at a time.
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
  "  assoc_category_ids TEXT NOT NULL DEFAULT ''," +
  "  track_against      TEXT NOT NULL DEFAULT ''," +
  "  past_value         REAL NOT NULL DEFAULT 0," +
  "  notes              TEXT NOT NULL DEFAULT ''," +
  "  old_account_ids    TEXT NOT NULL DEFAULT ''," +
  "  old_category_ids   TEXT NOT NULL DEFAULT ''," +
  "  created_at         TEXT NOT NULL DEFAULT (datetime('now'))," +
  "  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))" +
  ")",
  // A config_rows table created before these columns existed gets them here. SQLite has no
  // "ADD COLUMN IF NOT EXISTS", so ensureSchema() treats "duplicate column" on these as already done.
  "ALTER TABLE config_rows ADD COLUMN notes            TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE config_rows ADD COLUMN old_account_ids  TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE config_rows ADD COLUMN old_category_ids TEXT NOT NULL DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_config_rows_section ON config_rows (user_id, budget_id, section, position)",
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

// Editable / importable config_rows columns, in sheet order (shared by the API and its tests).
var CONFIG_COLUMNS = ['metric', 'type', 'text', 'section', 'amount', 'unit', 'multiplier', 'track_against',
  'date_range', 'assoc_category_ids', 'past_value', 'notes', 'old_account_ids', 'old_category_ids'];

module.exports = { STATEMENTS: STATEMENTS, ACCOUNT_GROUPS: ACCOUNT_GROUPS, CONFIG_COLUMNS: CONFIG_COLUMNS };
