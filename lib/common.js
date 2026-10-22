// Shared by the Turso-backed API handlers (account groups, config rows): who is calling, schema setup,
// reply shape. Transport-agnostic -- the Vercel and Cloudflare wrappers pass plain values in.
//
// Who is calling: the client sends its YNAB access token as `Authorization: Bearer <token>`. The server
// asks YNAB who that is (GET /v1/user) and uses the returned user id as the owner of the rows. The token
// is only forwarded to YNAB -- never logged or stored -- and only the holder of a valid YNAB token for
// that user can read or change that user's rows.

var turso = require('./turso.js');
var schema = require('./schema.js');

var YNAB_USER_URL = 'https://api.youneedabudget.com/v1/user';
var ID_RE = /^[A-Za-z0-9_-]{8,64}$/;           // YNAB ids are UUIDs

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
  for (var i = 0; i < schema.STATEMENTS.length; i++) {
    var sql = schema.STATEMENTS[i];
    try {
      await turso.execute(env, fetchImpl, sql, []);
    } catch (e) {
      // ADD COLUMN has no IF NOT EXISTS: "duplicate column" means the migration already happened
      if (/^ALTER TABLE/i.test(sql) && /duplicate column/i.test(String(e && e.message))) continue;
      throw e;
    }
  }
  schemaReady = true;
}

// Returns { userId } when the caller is a verified YNAB user, else { error: <reply> }.
async function authenticate(req, env, fetchImpl) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    return { error: reply(503, { error: 'not_configured', message: 'Database is not configured on this deployment' }) };
  }
  var m = /^Bearer\s+(.+)$/i.exec(req.authorization || '');
  if (!m) return { error: reply(401, { error: 'unauthorized', message: 'YNAB access token required' }) };
  var userId;
  try { userId = await ynabUserId(m[1].trim(), fetchImpl); }
  catch (e) { return { error: reply(502, { error: 'ynab_unavailable', message: 'Could not verify the YNAB token' }) }; }
  if (!userId) return { error: reply(401, { error: 'unauthorized', message: 'YNAB token was not accepted' }) };
  return { userId: userId };
}

module.exports = {
  ID_RE: ID_RE, reply: reply, ensureSchema: ensureSchema, authenticate: authenticate, ynabUserId: ynabUserId,
  _resetForTests: function() { schemaReady = false; userCache = {}; }
};
