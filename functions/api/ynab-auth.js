// Cloudflare Pages Function: same endpoint as /api/ynab-auth.js (Vercel), sharing lib/ynab-auth.js.
// Needs YNAB_CLIENT_SECRET (a Pages secret) plus TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
import core from '../../lib/ynab-auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  let body;
  if (request.method === 'POST') {
    try { body = await request.json(); } catch (e) { body = null; }
  }
  const out = await core.handle({ method: request.method, body: body }, env);
  return new Response(JSON.stringify(out.json), {
    status: out.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
