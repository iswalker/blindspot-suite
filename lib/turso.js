// Minimal Turso / libSQL client over its HTTP API (Hrana "v2/pipeline"), using only fetch so it runs
// unchanged in Vercel's Node functions and Cloudflare's Workers runtime with no npm dependency.
//   TURSO_DATABASE_URL  e.g. libsql://my-db-myorg.turso.io  (https://... also accepted)
//   TURSO_AUTH_TOKEN    a database token with read/write access (server-side only)

function baseUrl(env) {
  var url = (env.TURSO_DATABASE_URL || '').trim().replace(/\/+$/, '');
  return url.replace(/^libsql:\/\//, 'https://').replace(/^wss?:\/\//, 'https://');
}

function toArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}
function stmt(sql, args) { return { sql: sql, args: (args || []).map(toArg) }; }

function cellValue(c) {
  if (!c || c.type === 'null') return null;
  if (c.type === 'integer') return Number(c.value);
  return c.value;
}

async function pipeline(env, fetchImpl, requests) {
  var res = await (fetchImpl || fetch)(baseUrl(env) + '/v2/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.TURSO_AUTH_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: requests.concat([{ type: 'close' }]) })
  });
  if (!res.ok) throw new Error('Turso HTTP ' + res.status);
  var data = await res.json();
  return data.results || [];
}

// Runs one statement; returns { rows: [ {col: value} ], affected }.
async function execute(env, fetchImpl, sql, args) {
  var results = await pipeline(env, fetchImpl, [{ type: 'execute', stmt: stmt(sql, args) }]);
  var r = results[0];
  if (!r || r.type !== 'ok') throw new Error((r && r.error && r.error.message) || 'Turso statement failed');
  var result = r.response.result, cols = result.cols.map(function(c) { return c.name; });
  return {
    rows: result.rows.map(function(row) { var o = {}; cols.forEach(function(n, i) { o[n] = cellValue(row[i]); }); return o; }),
    affected: result.affected_row_count || 0
  };
}

// Runs statements in order inside one transaction: all of them commit, or none do.
// statements: [ [sql, args], ... ]
async function transaction(env, fetchImpl, statements) {
  var steps = [{ stmt: stmt('BEGIN') }];
  statements.forEach(function(s, i) { steps.push({ stmt: stmt(s[0], s[1]), condition: { type: 'ok', step: i } }); });
  var last = statements.length;
  steps.push({ stmt: stmt('COMMIT'), condition: { type: 'ok', step: last } });
  steps.push({ stmt: stmt('ROLLBACK'), condition: { type: 'not', cond: { type: 'ok', step: last + 1 } } });
  var results = await pipeline(env, fetchImpl, [{ type: 'batch', batch: { steps: steps } }]);
  var r = results[0];
  if (!r || r.type !== 'ok') throw new Error((r && r.error && r.error.message) || 'Turso batch failed');
  var errs = r.response.result.step_errors || [];
  for (var i = 0; i <= last + 1; i++) {
    if (errs[i]) throw new Error(errs[i].message || 'Turso statement failed');
  }
}

module.exports = { execute: execute, transaction: transaction };
