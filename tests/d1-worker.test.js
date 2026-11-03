import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.js';
import { QUERIES } from '../src/query-registry.js';

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
