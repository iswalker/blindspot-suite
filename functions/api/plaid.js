const PLAID_BASE = 'https://production.plaid.com';

const ALLOWED_ENDPOINTS = new Set([
  '/link/token/create',
  '/item/public_token/exchange',
  '/accounts/get',
  '/transactions/get',
]);

export async function onRequestPost({ request }) {
  let body = {};
  try {
    body = await request.json();
  } catch (_) {}

  const { endpoint, payload } = body || {};

  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return Response.json({ error_code: 'INVALID_ENDPOINT', error_message: 'Endpoint not allowed' }, { status: 400 });
  }

  try {
    const upstream = await fetch(PLAID_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json();
    return Response.json(data, { status: upstream.status });
  } catch (err) {
    return Response.json({ error_code: 'PROXY_ERROR', error_message: err.message }, { status: 500 });
  }
}

export function onRequest() {
  return new Response(null, { status: 405 });
}
