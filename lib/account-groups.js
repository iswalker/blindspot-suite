// Request logic for /api/account-groups, shared by the Vercel function (api/account-groups.js) and the
// Cloudflare Pages Function (functions/api/account-groups.js). Transport-agnostic: it takes plain
// values and returns { status, json }. Caller identification and schema setup live in ./common.js.

var turso = require('./turso.js');
var schema = require('./schema.js');
var common = require('./common.js');

var ID_RE = common.ID_RE;
var reply = common.reply;
var MAX_ASSIGNMENTS = 500;
var UNASSIGNED = 'Unassigned';                  // request-only value that clears an account's group

// req: { method, query: {budgetId}, body, authorization }, env: { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN }
async function handle(req, env, fetchImpl) {
  var auth = await common.authenticate(req, env, fetchImpl);
  if (auth.error) return auth.error;
  var userId = auth.userId;

  var method = (req.method || '').toUpperCase();
  try {
    await common.ensureSchema(env, fetchImpl);

    if (method === 'GET') {
      var budgetId = req.query && req.query.budgetId;
      if (!ID_RE.test(budgetId || '')) return reply(400, { error: 'bad_request', message: 'budgetId is required' });
      var r = await turso.execute(env, fetchImpl,
        'SELECT account_id, group_name FROM account_groups WHERE user_id = ? AND budget_id = ?', [userId, budgetId]);
      var groups = {};
      r.rows.forEach(function(row) { groups[row.account_id] = row.group_name; });
      return reply(200, { groups: groups });
    }

    if (method === 'PUT' || method === 'POST') {
      var body = req.body || {};
      var bid = body.budgetId;
      var list = body.assignments;
      if (!ID_RE.test(bid || '') || !Array.isArray(list)) return reply(400, { error: 'bad_request', message: 'budgetId and assignments are required' });
      if (list.length > MAX_ASSIGNMENTS) return reply(400, { error: 'bad_request', message: 'Too many assignments' });
      var stmts = [
        ["INSERT INTO users (user_id) VALUES (?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = datetime('now')", [userId]]
      ];
      for (var i = 0; i < list.length; i++) {
        var a = list[i] || {};
        if (!ID_RE.test(a.accountId || '') || (schema.ACCOUNT_GROUPS.indexOf(a.group) === -1 && a.group !== UNASSIGNED)) {
          return reply(400, { error: 'bad_request', message: 'Invalid assignment at index ' + i });
        }
        if (a.group === UNASSIGNED) {             // unassigned is the absence of a row
          stmts.push(['DELETE FROM account_groups WHERE user_id = ? AND budget_id = ? AND account_id = ?', [userId, bid, a.accountId]]);
        } else {
          stmts.push([
            "INSERT INTO account_groups (user_id, budget_id, account_id, group_name, updated_at) VALUES (?, ?, ?, ?, datetime('now')) " +
            "ON CONFLICT(user_id, budget_id, account_id) DO UPDATE SET group_name = excluded.group_name, updated_at = excluded.updated_at",
            [userId, bid, a.accountId, a.group]
          ]);
        }
      }
      await turso.transaction(env, fetchImpl, stmts);
      return reply(200, { ok: true, count: list.length });
    }

    return reply(405, { error: 'method_not_allowed' });
  } catch (e) {
    return reply(500, { error: 'server_error', message: 'Database request failed' });
  }
}

module.exports = { handle: handle, _resetForTests: common._resetForTests };
