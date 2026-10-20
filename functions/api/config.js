// Cloudflare Pages Function: same endpoint as /api/config.js (Vercel), sharing lib/config-rows.js.
// Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN as Pages variables/secrets.
import core from '../../lib/config-rows.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let body;
  if (request.method === 'PUT' || request.method === 'POST' || request.method === 'PATCH') {
    try { body = await request.json(); } catch (e) { body = null; }
  }
  const out = await core.handle({
    method: request.method,
    query: { budgetId: url.searchParams.get('budgetId'), section: url.searchParams.get('section') },
    body: body,
    authorization: request.headers.get('Authorization'),
  }, env);
  return new Response(JSON.stringify(out.json), {
    status: out.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
