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

function resolveVercelRewrite(input, rewriteRules = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8')).rewrites) {
  let current = new URL(input, 'https://preview.test');
  for (let iteration = 0; iteration < 10; iteration++) {
    let matched = false;
    for (const rule of rewriteRules) {
      let pathValue = null;
      if (rule.source === '/') {
        if (current.pathname !== '/') continue;
      } else if (rule.source === '/api/:path*') {
        const match = current.pathname.match(/^\/api\/(.*)$/);
        if (!match) continue;
        pathValue = match[1];
      } else if (rule.source === '/:path*') {
        const match = current.pathname.match(/^\/(.*)$/);
        if (!match) continue;
        pathValue = match[1];
      } else continue;

      if ((rule.missing || []).some(condition => condition.type === 'query' && current.searchParams.has(condition.key))) continue;
      const destination = rule.destination.replaceAll(':path*', pathValue ?? '');
      const next = new URL(destination, current.origin);
      for (const [key, value] of current.searchParams) {
        if (!next.searchParams.has(key)) next.searchParams.append(key, value);
      }
      current = next;
      matched = true;
      break;
    }
    if (!matched) return `${current.pathname}${current.search}`;
  }
  throw new Error('Rewrite recursion exceeded the test limit.');
}

async function invokeVercelTarget(target, { method = 'GET', body, auth = false } = {}) {
  const headers = { host: `127.0.0.1:${server.address().port}`, 'x-forwarded-proto': 'http' };
  if (method !== 'GET') headers.origin = base;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && cookie) headers.cookie = cookie;
  const response = await originalFetch(`${base}${target}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { response, data: await response.json().catch(() => null) };
}

async function rewrittenApi(path, options) {
  return invokeVercelTarget(resolveVercelRewrite(path), options);
}

after(async () => {
  await new Promise(resolveClose => server.close(resolveClose));
  sqlDb.close();
  globalThis.fetch = originalFetch;
});

test('rewrites Vercel conservan /api/config y /api/catalog usando el proxy D1', async () => {
  const routing = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8'));
  assert.ok(routing.rewrites.some(route => route.source === '/api/:path*' && route.destination === '/api/index?__path=/api/:path*'));
  assert.ok(routing.rewrites.find(route => route.source === '/api/:path*').missing?.some(condition => condition.key === '__path'));
  assert.ok(routing.rewrites.find(route => route.source === '/:path*').missing?.some(condition => condition.key === '__path'));
  const unsafeRules = routing.rewrites.map(route => ({ ...route, missing: undefined }));
  assert.throws(() => resolveVercelRewrite('/api/config', unsafeRules), /Rewrite recursion exceeded/);

  const apiTarget = resolveVercelRewrite('/api/config');
  const targetUrl = new URL(apiTarget, base);
  assert.equal(targetUrl.pathname, '/api/index');
  assert.equal(targetUrl.searchParams.get('__path'), '/api/config');
  const config = await invokeVercelTarget(apiTarget);
  assert.equal(config.response.status, 200);
  assert.equal(config.data.readOnlyPreview, false);
  assert.equal(config.data.adminEnabled, true);

  const directTarget = resolveVercelRewrite('/api/index?__path=%2Fapi%2Fconfig');
  assert.equal(new URL(directTarget, base).pathname, '/api/index');
  assert.equal(new URL(directTarget, base).searchParams.get('__path'), '/api/config');
  const directConfig = await invokeVercelTarget(directTarget);
  assert.equal(directConfig.response.status, 200);

  const duplicateTarget = resolveVercelRewrite('/api/index?__path=%2Fapi%2Findex&__path=%2Fapi%2Fconfig');
  assert.equal((await invokeVercelTarget(duplicateTarget)).response.status, 200);

  const catalog = await rewrittenApi('/api/catalog');
  assert.equal(catalog.response.status, 200);
  assert.deepEqual(catalog.data, []);
});

test('handler lee __path desde req.query si Vercel no lo incluye en req.url', async () => {
  const req = {
    method: 'GET',
    url: '/api/index',
    headers: { host: 'preview.test', 'x-forwarded-proto': 'https' },
    query: { __path: '/api/config' },
  };
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body = '') { this.body = String(body); },
  };
  await vercelHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).readOnlyPreview, false);
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
