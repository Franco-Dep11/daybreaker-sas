import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import worker from '../cloudflare/worker.js';

process.env.VERCEL = '1';
process.env.D1_PROXY_URL = 'https://d1-proxy.test';
process.env.D1_PROXY_SECRET = 'vercel-test-shared-secret-'.padEnd(40, 'v');
process.env.D1_PROXY_VERIFIED = 'true';
process.env.ADMIN_PASSWORD = 'vercel-test-admin-password';
process.env.NODE_ENV = 'production';

const sqlDb = new DatabaseSync(':memory:');
sqlDb.exec('PRAGMA foreign_keys = ON;');
sqlDb.exec(readFileSync(resolve('migrations/0001_initial.sql'), 'utf8'));
const binding = {
  prepare(sql) {
    return {
      bind(...params) {
        const statement = sqlDb.prepare(sql);
        return {
          first: async () => statement.get(...params) || null,
          all: async () => ({ results: statement.all(...params) }),
          run: async () => {
            const result = statement.run(...params);
            return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
          },
        };
      },
    };
  },
  async batch(statements) {
    sqlDb.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      sqlDb.exec('COMMIT');
      return results;
    } catch (error) {
      sqlDb.exec('ROLLBACK');
      throw error;
    }
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://d1-proxy.test') {
    return worker.fetch(input instanceof Request ? input : new Request(input, init), { D1_API_SECRET: process.env.D1_PROXY_SECRET, DB: binding });
  }
  return originalFetch(input, init);
};

const { default: vercelHandler } = await import('../api/index.js');
const server = createServer(vercelHandler);
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.PUBLIC_BASE_URL = base;
let cookie = '';

async function rewrittenApi(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { host: `127.0.0.1:${server.address().port}`, 'x-forwarded-proto': 'http' };
  if (method !== 'GET') headers.origin = base;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && cookie) headers.cookie = cookie;
  const response = await originalFetch(`${base}/api/index?__path=${encodeURIComponent(path)}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { response, data: await response.json().catch(() => null) };
}

after(async () => {
  await new Promise(resolveClose => server.close(resolveClose));
  sqlDb.close();
  globalThis.fetch = originalFetch;
});

test('rewrites Vercel conservan /api/config y /api/catalog usando el proxy D1', async () => {
  const routing = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8'));
  assert.ok(routing.rewrites.some(route => route.source === '/api/:path*' && route.destination === '/api/index?__path=/api/:path*'));
  const config = await rewrittenApi('/api/config');
  assert.equal(config.response.status, 200);
  assert.equal(config.data.readOnlyPreview, false);
  assert.equal(config.data.adminEnabled, true);

  const catalog = await rewrittenApi('/api/catalog');
  assert.equal(catalog.response.status, 200);
  assert.deepEqual(catalog.data, []);
});

test('Vercel permite login y CRUD administrativo cuando D1 está verificada', async () => {
  const login = await rewrittenApi('/api/admin/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.response.status, 200);
  assert.ok(cookie.startsWith('daybreaker_session='));

  const created = await rewrittenApi('/api/admin/products', { method: 'POST', auth: true, body: {
    name: 'Producto en preview', slug: 'producto-preview', retailPrice: '4500', availability: 'available',
  } });
  assert.equal(created.response.status, 201);
  assert.equal((await rewrittenApi('/api/catalog')).data[0].id, created.data.id);

  const edited = await rewrittenApi(`/api/admin/products/${created.data.id}`, { method: 'PUT', auth: true, body: {
    name: 'Producto editado', slug: 'producto-preview', retailPrice: '5000', availability: 'available',
  } });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.data.name, 'Producto editado');

  const archived = await rewrittenApi(`/api/admin/products/${created.data.id}`, { method: 'DELETE', auth: true });
  assert.equal(archived.response.status, 200);
  assert.deepEqual((await rewrittenApi('/api/catalog')).data, []);
});
