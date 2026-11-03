import { QUERIES } from '../src/query-registry.js';

const corsHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: corsHeaders });
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function readRequest(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 128 * 1024) { await reader.cancel(); throw new Error('Request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
  return body;
}

function validateStatement(statement) {
  if (!statement || typeof statement.id !== 'string' || !Object.hasOwn(QUERIES, statement.id)) throw new Error('Unknown query');
  if (!Array.isArray(statement.params) || statement.params.length > 100) throw new Error('Invalid parameters');
  return { sql: QUERIES[statement.id], params: statement.params };
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const secret = env.D1_API_SECRET;
    const authorization = request.headers.get('authorization') || '';
    if (!secret || !constantTimeEqual(authorization, `Bearer ${secret}`)) return json({ error: 'Unauthorized' }, 401);
    const path = new URL(request.url).pathname;
    try {
      const body = await readRequest(request);
      if (path === '/v1/health') {
        const row = await env.DB.prepare('SELECT 1 AS connected').first();
        return json({ connected: row?.connected === 1 });
      }
      if (path === '/v1/query') {
        const statement = validateStatement(body);
        const prepared = env.DB.prepare(statement.sql).bind(...statement.params);
        if (body.mode === 'get') return json({ result: await prepared.first() });
        if (body.mode === 'all') {
          const result = await prepared.all();
          return json({ results: result.results || [] });
        }
        if (body.mode === 'run') {
          const result = await prepared.run();
          return json({ result: { ...(result.meta || {}), changes: result.meta?.changes || 0, success: result.success } });
        }
        return json({ error: 'Invalid query mode' }, 400);
      }
      if (path === '/v1/batch') {
        if (!Array.isArray(body.statements) || body.statements.length < 1 || body.statements.length > 100) return json({ error: 'Invalid batch' }, 400);
        const statements = body.statements.map(validateStatement).map(item => env.DB.prepare(item.sql).bind(...item.params));
        const results = await env.DB.batch(statements);
        return json({ results: results.map(result => ({ success: result.success, meta: result.meta })) });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error.message || 'Database request failed' }, 400);
    }
  },
};
