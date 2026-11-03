import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';
import { QUERIES, queryId } from '../src/query-registry.js';
import { readFileSync } from 'node:fs';

test('Worker autentica las llamadas y rechaza consultas fuera de la lista permitida', async () => {
  const env = { D1_API_SECRET: 'a'.repeat(40), DB: { prepare() { throw new Error('No debe ejecutar SQL'); } } };
  const unauthorized = await worker.fetch(new Request('https://worker.test/v1/query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'q001', params: [], mode: 'all' }),
  }), env);
  assert.equal(unauthorized.status, 401);

  const rejected = await worker.fetch(new Request('https://worker.test/v1/query', {
    method: 'POST', headers: { authorization: `Bearer ${env.D1_API_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'SELECT * FROM orders', params: [], mode: 'all' }),
  }), env);
  assert.equal(rejected.status, 400);
  assert.ok(Object.keys(QUERIES).length >= 40);
});

test('Worker ejecuta una consulta registrada mediante parámetros enlazados', async () => {
  const env = {
    D1_API_SECRET: 'b'.repeat(40),
    DB: {
      prepare(sql) {
        assert.equal(sql, QUERIES.q001);
        return { bind: (...params) => ({ first: async () => ({ params }), all: async () => ({ results: [] }), run: async () => ({ success: true, meta: { changes: 1 } }) }) };
      },
    },
  };
  const response = await worker.fetch(new Request('https://worker.test/v1/query', {
    method: 'POST', headers: { authorization: `Bearer ${env.D1_API_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'q001', params: ['x'], mode: 'get' }),
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, { params: ['x'] });
});

test('Worker verifica el binding D1 sin exponer resultados comerciales', async () => {
  const env = {
    D1_API_SECRET: 'c'.repeat(40),
    DB: { prepare(sql) { assert.equal(sql, 'SELECT 1 AS connected'); return { first: async () => ({ connected: 1 }) }; } },
  };
  const response = await worker.fetch(new Request('https://worker.test/v1/health', {
    method: 'POST', headers: { authorization: `Bearer ${env.D1_API_SECRET}`, 'content-type': 'application/json' }, body: '{}',
  }), env);
  assert.deepEqual(await response.json(), { connected: true });
});

test('Worker sube y sirve imagenes desde R2 sin exponer el binding al navegador', async () => {
  const objects = new Map();
  const env = {
    D1_API_SECRET: 'r'.repeat(40),
    ASSETS: {
      async put(key, value, options) { objects.set(key, { bytes: value, contentType: options.httpMetadata.contentType }); },
      async get(key) { const object = objects.get(key); return object && { body: object.bytes, httpMetadata: { contentType: object.contentType } }; },
    },
  };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const upload = await worker.fetch(new Request('https://worker.test/v1/assets/upload?productId=123e4567-e89b-12d3-a456-426614174000', {
    method: 'POST', headers: { authorization: `Bearer ${env.D1_API_SECRET}`, 'content-type': 'image/png' }, body: png,
  }), env);
  assert.equal(upload.status, 200);
  const stored = await upload.json();
  assert.match(stored.key, /^products\/123e4567-e89b-12d3-a456-426614174000\/[a-f0-9-]{36}\.png$/);
  const served = await worker.fetch(new Request(stored.url), env);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await served.arrayBuffer())], [...png]);
  const unconfigured = await worker.fetch(new Request('https://worker.test/v1/assets/upload?productId=123e4567-e89b-12d3-a456-426614174000', {
    method: 'POST', headers: { authorization: `Bearer ${env.D1_API_SECRET}`, 'content-type': 'image/png' }, body: png,
  }), { D1_API_SECRET: env.D1_API_SECRET });
  assert.equal(unconfigured.status, 503);
});

test('cada consulta SQL literal del backend esta en la lista permitida de D1', () => {
  const source = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const sqlLiterals = [...source.matchAll(/db\.prepare\((['"`])([\s\S]*?)\1\)/g)]
    .map(([, , sql]) => sql).filter(sql => !sql.includes('${'));
  assert.ok(sqlLiterals.length >= 50);
  for (const sql of sqlLiterals) assert.ok(queryId(sql), `Consulta no registrada: ${sql.replace(/\s+/g, ' ').trim()}`);
  assert.ok(Object.keys(QUERIES).length >= 70);
});
