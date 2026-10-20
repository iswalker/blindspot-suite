// Request logic for /api/config: the "YNAB Config" rows, one area (config_rows.section) at a time.
// Shared by the Vercel function (api/config.js) and the Cloudflare Pages Function
// (functions/api/config.js); see ./common.js for how the caller is identified.
//
//   GET   ?budgetId=[&section=Runway]          -> { rows: [ {id, position, metric, type, text, ...} ] } (every area when no section)
//   PUT   { budgetId, section, rows: [...] }   -> replaces every row of that section (the one-time import)
//   PATCH { budgetId, section?, updates?: [ {id, text?, amount?, ...} ], inserts?: [ {...row} ], deletes?: [ids] }
//         -> edits, adds and removes rows in one transaction (an inserted row uses its own `section`, else `section`)

var turso = require('./turso.js');
var schema = require('./schema.js');
var common = require('./common.js');

var ID_RE = common.ID_RE;
var reply = common.reply;
var COLUMNS = schema.CONFIG_COLUMNS;
var NUMERIC = { multiplier: true, past_value: true };
var MAX_ROWS = 1000, MAX_UPDATES = 500, MAX_INSERTS = 200, MAX_DELETES = 200, MAX_TEXT = 20000;

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
      if (!ID_RE.test(budgetId || '')) return badRequest('budgetId is required');
      var r = await turso.execute(env, fetchImpl,
        'SELECT id, position, ' + COLUMNS.join(', ') + ' FROM config_rows WHERE user_id = ? AND budget_id = ?' + (section ? ' AND section = ?' : '') + ' ORDER BY section, position, id',
        section ? [userId, budgetId, section] : [userId, budgetId]);
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
      var pb = req.body || {}, pbid = pb.budgetId;
      var ups = pb.updates || [], ins = pb.inserts || [], dels = pb.deletes || [];
      if (!ID_RE.test(pbid || '') || !Array.isArray(ups) || !Array.isArray(ins) || !Array.isArray(dels)) return badRequest('budgetId and a list of changes are required');
      if (!ups.length && !ins.length && !dels.length) return badRequest('budgetId and a list of changes are required');
      if (ups.length > MAX_UPDATES || ins.length > MAX_INSERTS || dels.length > MAX_DELETES) return badRequest('Too many changes');
      var isec = pb.section;
      if (isec !== undefined && isec !== null && (typeof isec !== 'string' || isec.length > 80)) return badRequest('section is invalid');

      var ids = {}, ustmts = [], i2;
      for (var d = 0; d < dels.length; d++) {
        if (!Number.isInteger(dels[d])) return badRequest('Delete ' + d + ': id must be a whole number');
        ids[dels[d]] = true;
      }
      for (var u = 0; u < ups.length; u++) {
        var up = ups[u] || {};
        if (!Number.isInteger(up.id)) return badRequest('Update ' + u + ': id must be a whole number');
        if (ids[up.id] && dels.indexOf(up.id) !== -1) return badRequest('Update ' + u + ': row is also being deleted');
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
      if (idList.length) {
        var own = await turso.execute(env, fetchImpl,
          'SELECT COUNT(*) AS n FROM config_rows WHERE user_id = ? AND budget_id = ? AND id IN (' + idList.map(function() { return '?'; }).join(', ') + ')',
          [userId, pbid].concat(idList));
        if (own.rows[0].n !== idList.length) return reply(404, { error: 'not_found', message: 'Some rows were not found' });
      }
      var tx = [];
      if (ins.length) tx.push(["INSERT INTO users (user_id) VALUES (?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = datetime('now')", [userId]]);
      dels.forEach(function(id) { tx.push(['DELETE FROM config_rows WHERE id = ? AND user_id = ? AND budget_id = ?', [id, userId, pbid]]); });
      tx = tx.concat(ustmts);
      for (i2 = 0; i2 < ins.length; i2++) {
        var nf = cleanFields(ins[i2], true);
        if (typeof nf === 'string') return badRequest('Insert ' + i2 + ': ' + nf);
        var rsec = (ins[i2] && typeof ins[i2].section === 'string' && ins[i2].section.trim()) ? ins[i2].section : isec;
        if (typeof rsec !== 'string' || !rsec.trim() || rsec.length > 80) return badRequest('Insert ' + i2 + ': section is required');
        nf.section = rsec;
        tx.push([
          'INSERT INTO config_rows (user_id, budget_id, position, ' + COLUMNS.join(', ') + ') VALUES (?, ?, ' +
            '(SELECT COALESCE(MAX(position), -1) + 1 FROM config_rows WHERE user_id = ? AND budget_id = ? AND section = ?), ' +
            COLUMNS.map(function() { return '?'; }).join(', ') + ')',
          [userId, pbid, userId, pbid, rsec].concat(COLUMNS.map(function(c) { return nf[c]; }))
        ]);
      }
      await turso.transaction(env, fetchImpl, tx);
      return reply(200, { ok: true, updated: ups.length, inserted: ins.length, deleted: dels.length });
    }

    return reply(405, { error: 'method_not_allowed' });
  } catch (e) {
    return reply(500, { error: 'server_error', message: 'Database request failed' });
  }
}

module.exports = { handle: handle, _resetForTests: common._resetForTests };
