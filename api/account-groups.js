// Vercel serverless function. Logic lives in lib/account-groups.js (shared with the Cloudflare Pages
// Function in functions/api/account-groups.js). Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
const core = require('../lib/account-groups.js');

module.exports = async function handler(req, res) {
  const out = await core.handle({
    method: req.method,
    query: req.query || {},
    body: req.body,
    authorization: req.headers && req.headers.authorization,
  }, process.env);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(out.status).json(out.json);
};
