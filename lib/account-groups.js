// Request logic for /api/account-groups, shared by the Vercel function (api/account-groups.js) and the
// Cloudflare Pages Function (functions/api/account-groups.js). Transport-agnostic: it takes plain
// values and returns { status, json }.
//
// Who is calling: the client sends its YNAB access token as `Authorization: Bearer <token>`. The server
// asks YNAB who that is (GET /v1/user) and uses the returned user id as the owner of the rows. The token
// is only forwarded to YNAB -- it is never logged or stored -- and only the holder of a valid YNAB token
// for that user can read or change that user's rows.

var turso = require('./turso.js');
var schema = require('./schema.js');

var YNAB_USER_URL = 'https://api.youneedabudget.com/v1/user';
var ID_RE = /^[A-Za-z0-9_-]{8,64}$/;           // YNAB ids are UUIDs
var MAX_ASSIGNMENTS = 500;

var schemaReady = false;                        // per server instance; the statements are idempotent
var userCache = {};                             // token -> { id, exp }; in memory only
var USER_CACHE_MS = 5 * 60 * 1000;

function reply(status, json) { return { status: status, json: json }; }

async function ynabUserId(token, fetchImpl) {
  var hit = userCache[token];
  if (hit && hit.exp > Date.now()) return hit.id;
  var res = await (fetchImpl || fetch)(YNAB_USER_URL, { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error('YNAB HTTP ' + res.status);
  var data = await res.json();
  var id = data && data.data && data.data.user && data.data.user.id;
  if (!id) return null;
  userCache[token] = { id: id, exp: Date.now() + USER_CACHE_MS };
  return id;
}

async function ensureSchema(env, fetchImpl) {
  if (schemaReady) return;
  for (var i = 0; i < schema.STATEMENTS.length; i++) await turso.execute(env, fetchImpl, schema.STATEMENTS[i], []);
  schemaReady = true;
}

// req: { method, query: {budgetId}, body, authorization }, env: { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN }
async function handle(req, env, fetchImpl) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    return reply(503, { error: 'not_configured', message: 'Database is not configured on this deployment' });
  }
  var m = /^Bearer\s+(.+)$/i.exec(req.authorization || '');
  if (!m) return reply(401, { error: 'unauthorized', message: 'YNAB access token required' });

  var userId;
  try { userId = await ynabUserId(m[1].trim(), fetchImpl); }
  catch (e) { return reply(502, { error: 'ynab_unavailable', message: 'Could not verify the YNAB token' }); }
  if (!userId) return reply(401, { error: 'unauthorized', message: 'YNAB token was not accepted' });

  var method = (req.method || '').toUpperCase();
  try {
    await ensureSchema(env, fetchImpl);

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
        if (!ID_RE.test(a.accountId || '') || schema.ACCOUNT_GROUPS.indexOf(a.group) === -1) {
          return reply(400, { error: 'bad_request', message: 'Invalid assignment at index ' + i });
        }
        if (a.group === 'Other') {                // unassigned == Other, so there is nothing to keep
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

module.exports = { handle: handle, _resetForTests: function() { schemaReady = false; userCache = {}; } };
