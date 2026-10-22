// /api/ynab-auth: server side of YNAB's authorization-code sign-in, shared by the Vercel function
// (api/ynab-auth.js) and the Cloudflare Pages Function (functions/api/ynab-auth.js).
//
// Why it exists: the implicit flow the app used before hands the browser a 2-hour access token and no way
// to renew it. The code flow also yields a refresh token, but exchanging a code needs the app's client
// secret, which must never reach the browser -- hence this endpoint.
//
//   GET                             -> { configured }  (can the code flow be used on this deployment?)
//   POST { action:'exchange', code, redirectUri }  -> { access_token, expires_in, session }
//   POST { action:'refresh',  session }            -> { access_token, expires_in }
//   POST { action:'logout',   session }            -> { ok:true }
//
// The browser keeps only the short-lived access token and `session`, an opaque random id. The refresh
// token stays here in Turso, encrypted (AES-GCM, key derived from YNAB_CLIENT_SECRET); only the SHA-256 of
// the session id is stored. Env: YNAB_CLIENT_SECRET (required), YNAB_CLIENT_ID (optional override),
// TURSO_DATABASE_URL, TURSO_AUTH_TOKEN.

var turso = require('./turso.js');
var common = require('./common.js');

var reply = common.reply;
var TOKEN_URL = 'https://app.youneedabudget.com/oauth/token';
var DEFAULT_CLIENT_ID = '4kfM_nRVgdGVIVsJZi9ivNb9FTmTA7-oyolX8uB0AAA';   // public; same as the one in index.html
var MAX_SESSIONS_PER_USER = 10;

function subtle() {
  var c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('Web Crypto is not available in this runtime');
  return c;
}
function toB64(bytes) {
  var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(str) {
  var s = atob(str), out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function b64url(bytes) { return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha256(text) { return new Uint8Array(await subtle().subtle.digest('SHA-256', new TextEncoder().encode(text))); }
function hex(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }

async function aesKey(env) {
  var raw = await sha256('blindspot-ynab-refresh|' + env.YNAB_CLIENT_SECRET);
  return subtle().subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encrypt(env, text) {
  var iv = subtle().getRandomValues(new Uint8Array(12));
  var ct = new Uint8Array(await subtle().subtle.encrypt({ name: 'AES-GCM', iv: iv }, await aesKey(env), new TextEncoder().encode(text)));
  var out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return toB64(out);
}
async function decrypt(env, b64) {
  var all = fromB64(b64);
  var pt = await subtle().subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await aesKey(env), all.slice(12));
  return new TextDecoder().decode(pt);
}

// YNAB's token endpoint takes its parameters in the query string. Returns { ok, status, body }.
async function tokenRequest(env, fetchImpl, params) {
  var q = Object.keys(params).map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  var res = await (fetchImpl || fetch)(TOKEN_URL + '?' + q, { method: 'POST' });
  var body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { ok: res.ok && !!(body && body.access_token), status: res.status, body: body || {} };
}
function clientParams(env) {
  return { client_id: env.YNAB_CLIENT_ID || DEFAULT_CLIENT_ID, client_secret: env.YNAB_CLIENT_SECRET };
}
function tokensReply(t) {
  return { access_token: t.access_token, expires_in: Number(t.expires_in) > 0 ? Number(t.expires_in) : 7200 };
}

function configured(env) {
  return !!(env.YNAB_CLIENT_SECRET && env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN);
}

async function exchange(body, env, fetchImpl) {
  var code = body.code, redirectUri = body.redirectUri;
  if (typeof code !== 'string' || !code || code.length > 512 || typeof redirectUri !== 'string' || !/^https?:\/\//.test(redirectUri) || redirectUri.length > 512) {
    return reply(400, { error: 'bad_request', message: 'code and redirectUri are required' });
  }
  var t = await tokenRequest(env, fetchImpl, Object.assign(clientParams(env), { grant_type: 'authorization_code', code: code, redirect_uri: redirectUri }));
  if (!t.ok || !t.body.refresh_token) {
    return reply(400, { error: 'exchange_failed', message: (t.body && (t.body.error_description || t.body.error)) || ('YNAB token HTTP ' + t.status) });
  }
  var userId = await common.ynabUserId(t.body.access_token, fetchImpl);
  if (!userId) return reply(502, { error: 'ynab_unavailable', message: 'Could not identify the YNAB user' });

  var session = b64url(subtle().getRandomValues(new Uint8Array(32)));
  var hash = hex(await sha256(session));
  await turso.transaction(env, fetchImpl, [
    ['INSERT INTO ynab_sessions (session_hash, user_id, refresh_token_enc) VALUES (?, ?, ?)', [hash, userId, await encrypt(env, t.body.refresh_token)]],
    // keep only this user's newest sessions so abandoned browsers don't pile up
    ['DELETE FROM ynab_sessions WHERE user_id = ? AND session_hash NOT IN (' +
      'SELECT session_hash FROM ynab_sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ' + MAX_SESSIONS_PER_USER + ')', [userId, userId]]
  ]);
  var out = tokensReply(t.body); out.session = session;
  return reply(200, out);
}

var inflight = {};                              // session hash -> pending refresh in this server instance

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// Two tabs refreshing at once must not both spend the same single-use refresh token: callers landing on
// the same server instance share one upstream call (the others get its result).
async function refresh(body, env, fetchImpl) {
  var session = body.session;
  if (typeof session !== 'string' || session.length < 20 || session.length > 128) return reply(401, { error: 'unauthorized', message: 'Unknown session' });
  var hash = hex(await sha256(session));
  if (inflight[hash]) return inflight[hash];
  var p = refreshOnce(hash, env, fetchImpl);
  inflight[hash] = p;
  try { return await p; } finally { delete inflight[hash]; }
}

async function refreshOnce(hash, env, fetchImpl) {
  var row = (await turso.execute(env, fetchImpl, 'SELECT refresh_token_enc FROM ynab_sessions WHERE session_hash = ?', [hash])).rows[0];
  if (!row) return reply(401, { error: 'unauthorized', message: 'Unknown session' });

  // YNAB may rotate the refresh token on use. If a second tab rotated it between our read and our call,
  // our copy is dead -- re-read once and retry with the newer one before giving up.
  for (var attempt = 0; attempt < 2; attempt++) {
    var oldEnc = row.refresh_token_enc, refreshToken;
    try { refreshToken = await decrypt(env, oldEnc); }
    catch (e) { return reply(401, { error: 'unauthorized', message: 'Stored token could not be read (client secret changed?)' }); }
    var t = await tokenRequest(env, fetchImpl, Object.assign(clientParams(env), { grant_type: 'refresh_token', refresh_token: refreshToken }));
    if (t.ok) {
      if (t.body.refresh_token && t.body.refresh_token !== refreshToken) {
        // compare-and-swap: a concurrent refresh that already stored a newer token wins
        await turso.execute(env, fetchImpl,
          "UPDATE ynab_sessions SET refresh_token_enc = ?, updated_at = datetime('now') WHERE session_hash = ? AND refresh_token_enc = ?",
          [await encrypt(env, t.body.refresh_token), hash, oldEnc]);
      } else {
        await turso.execute(env, fetchImpl, "UPDATE ynab_sessions SET updated_at = datetime('now') WHERE session_hash = ?", [hash]);
      }
      return reply(200, tokensReply(t.body));
    }
    if (t.status >= 500) return reply(502, { error: 'ynab_unavailable', message: 'YNAB token endpoint failed (HTTP ' + t.status + ')' });
    // Rejected. Either YNAB revoked it, or another instance just spent it and is about to store the
    // successor -- give that a moment to land before treating the session as dead.
    var again = null;
    for (var wait = 0; wait < 4; wait++) {
      again = (await turso.execute(env, fetchImpl, 'SELECT refresh_token_enc FROM ynab_sessions WHERE session_hash = ?', [hash])).rows[0];
      if (!again || again.refresh_token_enc !== oldEnc) break;
      await sleep(300);
    }
    if (!again) break;
    if (again.refresh_token_enc === oldEnc) {
      await turso.execute(env, fetchImpl, 'DELETE FROM ynab_sessions WHERE session_hash = ?', [hash]);   // genuinely revoked
      break;
    }
    row = again;
  }
  return reply(401, { error: 'unauthorized', message: 'YNAB sign-in expired; log in again' });
}

async function logout(body, env, fetchImpl) {
  if (typeof body.session === 'string' && body.session.length >= 20 && body.session.length <= 128) {
    await turso.execute(env, fetchImpl, 'DELETE FROM ynab_sessions WHERE session_hash = ?', [hex(await sha256(body.session))]);
  }
  return reply(200, { ok: true });
}

// req: { method, body }, env: { YNAB_CLIENT_SECRET, [YNAB_CLIENT_ID], TURSO_DATABASE_URL, TURSO_AUTH_TOKEN }
async function handle(req, env, fetchImpl) {
  var method = (req.method || '').toUpperCase();
  if (method === 'GET') return reply(200, { configured: configured(env) });
  if (method !== 'POST') return reply(405, { error: 'method_not_allowed', message: 'Use GET or POST' });
  if (!configured(env)) return reply(503, { error: 'not_configured', message: 'YNAB_CLIENT_SECRET and the Turso database must be set on this deployment' });
  var body = req.body || {};
  try {
    await common.ensureSchema(env, fetchImpl);
    if (body.action === 'exchange') return await exchange(body, env, fetchImpl);
    if (body.action === 'refresh')  return await refresh(body, env, fetchImpl);
    if (body.action === 'logout')   return await logout(body, env, fetchImpl);
    return reply(400, { error: 'bad_request', message: 'Unknown action' });
  } catch (e) {
    return reply(500, { error: 'server_error', message: 'Sign-in service failed' });
  }
}

module.exports = { handle: handle };
