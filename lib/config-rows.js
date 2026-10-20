// Request logic for /api/config: the "YNAB Config" rows, one area (config_rows.section) at a time.
// Shared by the Vercel function (api/config.js) and the Cloudflare Pages Function
// (functions/api/config.js); see ./common.js for how the caller is identified.
//
//   GET   ?budgetId=&section=Runway            -> { rows: [ {id, position, metric, type, text, ...} ] }
//   PUT   { budgetId, section, rows: [...] }   -> replaces every row of that section (the one-time import)
//   PATCH { budgetId, updates: [ {id, text?, amount?, ...} ] } -> edits individual rows by id

var turso = require('./turso.js');
var schema = require('./schema.js');
var common = require('./common.js');

var ID_RE = common.ID_RE;
var reply = common.reply;
var COLUMNS = schema.CONFIG_COLUMNS;
var NUMERIC = { multiplier: true, past_value: true };
var MAX_ROWS = 1000, MAX_UPDATES = 200, MAX_TEXT = 20000;

function badRequest(message) { return reply(400, { error: 'bad_request', message: message }); }

// Returns a clean { column: value } object for the columns present in `src` (all of them when `all`),
// or a string describing what is wrong.
function cleanFields(src, all) {
  var out = {};
  for (var i = 0; i < COLUMNS.length; i++) {
    var c = COLUMNS[i], v = src ? src[c] : undefined;
    if (v === undefined) {
      if (!all) continue;
      v = c === 'multiplier' ? null : c === 'past_value' ? 0 : '';
    }
    if (NUMERIC[c]) {
      if (v === null || v === '') { v = c === 'multiplier' ? null : 0; }
      else if (typeof v !== 'number' || !isFinite(v)) return c + ' must be a number';
    } else {
      if (v === null) v = '';
      if (typeof v !== 'string') return c + ' must be text';
      if (v.length > MAX_TEXT) return c + ' is too long';
    }
    out[c] = v;
  }
  return out;
}

function toApiRow(r) {
  var o = { id: r.id, position: r.position };
  COLUMNS.forEach(function(c) { o[c] = r[c]; });
  return o;
}

async function handle(req, env, fetchImpl) {
  var auth = await common.authenticate(req, env, fetchImpl);
  if (auth.error) return auth.error;
  var userId = auth.userId;
  var method = (req.method || '').toUpperCase();

  try {
    await common.ensureSchema(env, fetchImpl);

    if (method === 'GET') {
      var budgetId = req.query && req.query.budgetId, section = req.query && req.query.section;
      if (!ID_RE.test(budgetId || '') || !section) return badRequest('budgetId and section are required');
      var r = await turso.execute(env, fetchImpl,
        'SELECT id, position, ' + COLUMNS.join(', ') + ' FROM config_rows WHERE user_id = ? AND budget_id = ? AND section = ? ORDER BY position, id',
        [userId, budgetId, section]);
      return reply(200, { rows: r.rows.map(toApiRow) });
    }

    if (method === 'PUT' || method === 'POST') {
      var body = req.body || {};
      var bid = body.budgetId, sec = body.section, list = body.rows;
      if (!ID_RE.test(bid || '') || typeof sec !== 'string' || !sec.trim() || sec.length > 80 || !Array.isArray(list)) {
        return badRequest('budgetId, section and rows are required');
      }
      if (list.length > MAX_ROWS) return badRequest('Too many rows');
      var stmts = [
        ["INSERT INTO users (user_id) VALUES (?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = datetime('now')", [userId]],
        ['DELETE FROM config_rows WHERE user_id = ? AND budget_id = ? AND section = ?', [userId, bid, sec]]
      ];
      for (var i = 0; i < list.length; i++) {
        var f = cleanFields(list[i], true);
        if (typeof f === 'string') return badRequest('Row ' + i + ': ' + f);
        f.section = sec;                          // a replace only ever touches its own area
        stmts.push([
          'INSERT INTO config_rows (user_id, budget_id, position, ' + COLUMNS.join(', ') + ') VALUES (?, ?, ?, ' + COLUMNS.map(function() { return '?'; }).join(', ') + ')',
          [userId, bid, i].concat(COLUMNS.map(function(c) { return f[c]; }))
        ]);
      }
      await turso.transaction(env, fetchImpl, stmts);
      return reply(200, { ok: true, count: list.length });
    }

    if (method === 'PATCH') {
      var pb = req.body || {}, pbid = pb.budgetId, ups = pb.updates;
      if (!ID_RE.test(pbid || '') || !Array.isArray(ups) || !ups.length) return badRequest('budgetId and updates are required');
      if (ups.length > MAX_UPDATES) return badRequest('Too many updates');
      var ustmts = [], ids = {};
      for (var u = 0; u < ups.length; u++) {
        var up = ups[u] || {};
        if (!Number.isInteger(up.id)) return badRequest('Update ' + u + ': id must be a whole number');
        var uf = cleanFields(up, false);
        if (typeof uf === 'string') return badRequest('Update ' + u + ': ' + uf);
        var cols = Object.keys(uf);
        if (!cols.length) return badRequest('Update ' + u + ': nothing to change');
        ids[up.id] = true;
        ustmts.push([
          'UPDATE config_rows SET ' + cols.map(function(c) { return c + ' = ?'; }).join(', ') + ", updated_at = datetime('now') WHERE id = ? AND user_id = ? AND budget_id = ?",
          cols.map(function(c) { return uf[c]; }).concat([up.id, userId, pbid])
        ]);
      }
      var idList = Object.keys(ids).map(Number);
      var own = await turso.execute(env, fetchImpl,
        'SELECT COUNT(*) AS n FROM config_rows WHERE user_id = ? AND budget_id = ? AND id IN (' + idList.map(function() { return '?'; }).join(', ') + ')',
        [userId, pbid].concat(idList));
      if (own.rows[0].n !== idList.length) return reply(404, { error: 'not_found', message: 'Some rows were not found' });
      await turso.transaction(env, fetchImpl, ustmts);
      return reply(200, { ok: true, count: ups.length });
    }

    return reply(405, { error: 'method_not_allowed' });
  } catch (e) {
    return reply(500, { error: 'server_error', message: 'Database request failed' });
  }
}

module.exports = { handle: handle, _resetForTests: common._resetForTests };
