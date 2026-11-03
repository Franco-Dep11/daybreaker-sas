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
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.startsWith('/assets/products/')) {
      if (!/^\/assets\/products\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:jpg|png|webp)$/.test(url.pathname)) return new Response('Not found', { status: 404 });
      if (!env.ASSETS) return new Response('Image storage is not configured', { status: 503 });
      const object = await env.ASSETS.get(url.pathname.slice('/assets/'.length));
      if (!object) return new Response('Not found', { status: 404 });
      return new Response(object.body, { headers: { 'content-type': object.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const secret = env.D1_API_SECRET;
    const authorization = request.headers.get('authorization') || '';
    if (!secret || !constantTimeEqual(authorization, `Bearer ${secret}`)) return json({ error: 'Unauthorized' }, 401);
    const path = new URL(request.url).pathname;
    try {
      if (path === '/v1/assets/upload') {
        if (!env.ASSETS) return json({ error: 'El almacenamiento de imágenes R2 todavía no está configurado.' }, 503);
        const productId = url.searchParams.get('productId') || '';
        if (!/^[a-f0-9-]{36}$/i.test(productId)) return json({ error: 'Producto inválido.' }, 400);
        const contentType = request.headers.get('content-type') || '';
        const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[contentType];
        if (!extension) return json({ error: 'Usá imágenes JPEG, PNG o WebP.' }, 415);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!bytes.length || bytes.byteLength > 4 * 1024 * 1024) return json({ error: 'Cada imagen debe pesar hasta 4 MB.' }, 413);
        const valid = extension === 'jpg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
          : extension === 'png' ? bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
            : new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
        if (!valid) return json({ error: 'El archivo no coincide con el formato declarado.' }, 415);
        const key = `products/${productId}/${crypto.randomUUID()}.${extension}`;
        await env.ASSETS.put(key, bytes, { httpMetadata: { contentType } });
        return json({ key, url: new URL(`/assets/${key}`, request.url).href });
      }
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
