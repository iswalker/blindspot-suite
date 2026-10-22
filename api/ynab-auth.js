// Vercel serverless function. Logic lives in lib/ynab-auth.js (shared with the Cloudflare Pages Function in
// functions/api/ynab-auth.js). Needs YNAB_CLIENT_SECRET, TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
const core = require('../lib/ynab-auth.js');

module.exports = async function handler(req, res) {
  const out = await core.handle({ method: req.method, body: req.body }, process.env);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(out.status).json(out.json);
};
