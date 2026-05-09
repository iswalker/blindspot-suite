const PLAID_BASE = 'https://sandbox.plaid.com';

const ALLOWED_ENDPOINTS = new Set([
  '/link/token/create',
  '/item/public_token/exchange',
  '/accounts/get',
  '/transactions/get',
]);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { endpoint, payload } = req.body || {};

  if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
    return res.status(400).json({ error_code: 'INVALID_ENDPOINT', error_message: 'Endpoint not allowed' });
  }

  try {
    const upstream = await fetch(PLAID_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error_code: 'PROXY_ERROR', error_message: err.message });
  }
};
