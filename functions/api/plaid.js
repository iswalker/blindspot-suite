// Cloudflare Pages Functions port of /api/plaid.js (Vercel's serverless-function format isn't
// recognized by Cloudflare Pages -- it only auto-routes files under /functions, using the
// Fetch API Request/Response signature below instead of Vercel's (req, res)). Keep this in sync
// with /api/plaid.js; both are plain passthrough proxies (the client already embeds
// client_id/secret in payload) that exist only so the browser doesn't call Plaid cross-origin.
const PLAID_BASE = 'https://production.plaid.com';

const ALLOWED_ENDPOINTS = new Set([
  '/link/token/create',
  '/item/public_token/exchange',
  '/accounts/get',
  '/transactions/get',
]);

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch (err) {
    return json({ error_code: 'INVALID_BODY', error_message: 'Malformed JSON body' }, 400);
  }

  var endpoint = body && body.endpoint;
  var payload = body && body.payload;

  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return json({ error_code: 'INVALID_ENDPOINT', error_message: 'Endpoint not allowed' }, 400);
  }

  try {
    const upstream = await fetch(PLAID_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json();
    return json(data, upstream.status);
  } catch (err) {
    return json({ error_code: 'PROXY_ERROR', error_message: err.message }, 500);
  }
}
