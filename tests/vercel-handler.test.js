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
process.env.ADMIN_USER = 'vercel-admin';
process.env.NODE_ENV = 'production';

const sqlDb = new DatabaseSync(':memory:');
let assetsBinding = null;
sqlDb.exec('PRAGMA foreign_keys = ON;');
sqlDb.exec(readFileSync(resolve('migrations/0001_initial.sql'), 'utf8'));
sqlDb.prepare('INSERT INTO products (id, slug, name, retail_price_cents, availability, image_url, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)').run('legacy-product', 'legacy-product', 'Legacy preservado', 125000, 'available', 'https://images.example.test/legacy.jpg', new Date().toISOString(), new Date().toISOString());
sqlDb.prepare(`INSERT INTO orders (id, tracking_token_hash, customer_name, email, phone, address, province, locality, postal_code, subtotal_cents, total_cents, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('legacy-order', 'a'.repeat(64), 'Cliente historico', 'legacy@example.test', '1111111111', 'Calle 1', 'Buenos Aires', 'La Plata', '1900', 125000, 125000, 'delivered', new Date().toISOString(), new Date().toISOString());
sqlDb.prepare('INSERT INTO order_items (id, order_id, product_id, product_slug, product_name, unit_price_cents, quantity, line_total_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('legacy-order-item', 'legacy-order', 'legacy-product', 'legacy-product', 'Legacy preservado', 125000, 1, 125000);
sqlDb.exec(readFileSync(resolve('migrations/0002_admin_catalog.sql'), 'utf8'));
sqlDb.exec(readFileSync(resolve('migrations/0003_product_image_positions.sql'), 'utf8'));
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
    return worker.fetch(input instanceof Request ? input : new Request(input, init), { D1_API_SECRET: process.env.D1_PROXY_SECRET, DB: binding, ...(assetsBinding ? { ASSETS: assetsBinding } : {}) });
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

async function invokeVercelTarget(target, { method = 'GET', body, auth = false, contentType, rawBody } = {}) {
  const headers = { host: `127.0.0.1:${server.address().port}`, 'x-forwarded-proto': 'http' };
  if (method !== 'GET') headers.origin = base;
  if (contentType) headers['content-type'] = contentType;
  else if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && cookie) headers.cookie = cookie;
  const response = await originalFetch(`${base}${target}`, {
    method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
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
  assert.deepEqual(catalog.data.map(product => product.id), ['legacy-product']);
  assert.equal(catalog.data[0].availability, 'available');
  assert.equal(catalog.data[0].stockQuantity, 0);
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
  const login = await rewrittenApi('/api/admin/login', { method: 'POST', body: { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.response.status, 200);
  assert.ok(cookie.startsWith('daybreaker_session='));

  const created = await rewrittenApi('/api/admin/products', { method: 'POST', auth: true, body: {
    name: 'Producto en preview', slug: 'producto-preview', retailPrice: '4500', availability: 'available',
  } });
  assert.equal(created.response.status, 201);
  const hidden = await rewrittenApi(`/api/admin/products/${created.data.id}/visibility`, { method: 'PATCH', auth: true, body: { visibleInStore: false } });
  assert.deepEqual(hidden.data, { id: created.data.id, visibleInStore: false });
  assert.deepEqual({ ...sqlDb.prepare('SELECT visible_in_store, retail_price_cents FROM products WHERE id = ?').get(created.data.id) }, { visible_in_store: 0, retail_price_cents: 450000 });
  const hiddenAdminProduct = (await rewrittenApi('/api/admin/products', { auth: true })).data.find(item => item.id === created.data.id);
  assert.equal(hiddenAdminProduct.active, true);
  assert.equal(hiddenAdminProduct.visibleInStore, false);
  assert.equal((await rewrittenApi('/api/catalog')).data.some(product => product.id === created.data.id), false);
  const shown = await rewrittenApi(`/api/admin/products/${created.data.id}/visibility`, { method: 'PATCH', auth: true, body: { visibleInStore: true } });
  assert.equal(shown.data.visibleInStore, true);
  assert.equal((await rewrittenApi('/api/catalog')).data.some(product => product.id === created.data.id), true);
  assert.ok((await rewrittenApi('/api/catalog')).data.some(product => product.id === created.data.id));
  const imageNotConfigured = await rewrittenApi(`/api/admin/products/${created.data.id}/images`, { method: 'POST', auth: true, contentType: 'image/png', rawBody: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  assert.equal(imageNotConfigured.response.status, 503);
  assert.match(imageNotConfigured.data.error, /R2/);

  const edited = await rewrittenApi(`/api/admin/products/${created.data.id}`, { method: 'PUT', auth: true, body: {
    name: 'Producto editado', slug: 'producto-preview', retailPrice: '5000', availability: 'available',
  } });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.data.name, 'Producto editado');

  const archived = await rewrittenApi(`/api/admin/products/${created.data.id}`, { method: 'DELETE', auth: true });
  assert.equal(archived.response.status, 200);
  assert.deepEqual((await rewrittenApi('/api/catalog')).data.map(product => product.id), ['legacy-product']);
});

test('0002 conserva productos existentes y D1 administra categorias, stock y visibilidad', async () => {
  assert.deepEqual({ ...sqlDb.prepare('SELECT id, slug, retail_price_cents, visible_in_store FROM products WHERE id = ?').get('legacy-product') },
    { id: 'legacy-product', slug: 'legacy-product', retail_price_cents: 125000, visible_in_store: 1 });
  assert.equal((await rewrittenApi('/api/admin/categories')).response.status, 401);
  assert.equal(sqlDb.prepare('SELECT id FROM product_images WHERE id = ?').get('legacy-image-legacy-product').id, 'legacy-image-legacy-product');
  const legacyProduct = sqlDb.prepare('SELECT availability, stock_quantity, category_id, visible_in_store FROM products WHERE id = ?').get('legacy-product');
  assert.deepEqual({ ...legacyProduct }, { availability: 'available', stock_quantity: 0, category_id: null, visible_in_store: 1 });
  assert.equal(sqlDb.prepare('SELECT COUNT(*) AS count FROM orders WHERE id = ?').get('legacy-order').count, 1);
  assert.equal(sqlDb.prepare('SELECT product_name, unit_price_cents FROM order_items WHERE id = ?').get('legacy-order-item').product_name, 'Legacy preservado');
  const login = await rewrittenApi('/api/admin/login', { method: 'POST', body: { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.response.status, 200);
  const legacyAdminProduct = (await rewrittenApi('/api/admin/products', { auth: true })).data.find(item => item.id === 'legacy-product');
  assert.equal(legacyAdminProduct.availability, 'available');
  assert.equal(legacyAdminProduct.stockQuantity, 0);
  assert.equal(legacyAdminProduct.categoryId, '');
  const category = await rewrittenApi('/api/admin/categories', { method: 'POST', auth: true, body: { name: 'Sillas operativas' } });
  assert.equal(category.response.status, 201);
  const subcategory = await rewrittenApi(`/api/admin/categories/${category.data.id}/subcategories`, { method: 'POST', auth: true, body: { name: 'Linea ejecutiva' } });
  assert.equal(subcategory.response.status, 201);
  const created = await rewrittenApi('/api/admin/products', { method: 'POST', auth: true, body: {
    name: 'Silla Nova', retailPrice: '485000', availability: 'available', categoryId: category.data.id,
    subcategoryId: subcategory.data.id, stockQuantity: 7, specifications: 'Material: acero', attributes: [{ name: 'Capacidad', value: '120 kg' }],
  } });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.stockQuantity, 7);
  assert.equal(created.data.categoryId, category.data.id);
  assert.deepEqual(created.data.attributes, [{ name: 'Capacidad', value: '120 kg' }]);
  const oldSlug = created.data.slug;
  const hidden = await rewrittenApi(`/api/admin/products/${created.data.id}`, { method: 'PUT', auth: true, body: {
    ...created.data, retailPrice: '500000', name: 'Silla Nova actualizada', visibleInStore: false,
  } });
  assert.equal(hidden.data.slug, oldSlug);
  assert.equal(hidden.data.visibleInStore, false);
  assert.equal(hidden.data.retailPriceCents, 50000000);
  assert.equal((await rewrittenApi('/api/catalog')).data.some(product => product.id === created.data.id), false);
  const hiddenOrder = await rewrittenApi('/api/orders', { method: 'POST', body: {
    customerName: 'Comprador', email: 'buyer@example.test', phone: '1122334455', address: 'Calle 10', province: 'Buenos Aires', locality: 'La Plata', postalCode: '1900', items: [{ productId: created.data.id, quantity: 1 }],
  } });
  assert.equal(hiddenOrder.response.status, 400);
  const hiddenQuote = await rewrittenApi('/api/quotes', { method: 'POST', body: {
    companyName: 'Comprador mayorista', email: 'buyer@example.test', phone: '1122334455', destination: 'La Plata', items: [{ productId: created.data.id, quantity: 1 }],
  } });
  assert.equal(hiddenQuote.response.status, 400);
  const shown = await rewrittenApi(`/api/admin/products/${created.data.id}`, { method: 'PUT', auth: true, body: {
    ...hidden.data, retailPrice: '500000', visibleInStore: true,
  } });
  assert.equal(shown.data.visibleInStore, true);
  assert.ok((await rewrittenApi('/api/catalog')).data.some(product => product.id === created.data.id));

  const otherCategory = await rewrittenApi('/api/admin/categories', { method: 'POST', auth: true, body: { name: 'Otra categoria' } });
  const mismatchedSubcategory = await rewrittenApi(`/api/admin/products/${created.data.id}`, { method: 'PUT', auth: true, body: {
    ...shown.data, retailPrice: '500000', categoryId: otherCategory.data.id, subcategoryId: subcategory.data.id,
  } });
  assert.equal(mismatchedSubcategory.response.status, 400);

  const objects = new Map();
  assetsBinding = {
    async put(key, bytes, options) { objects.set(key, { bytes, contentType: options.httpMetadata.contentType }); },
    async get(key) { const object = objects.get(key); return object && { body: object.bytes, httpMetadata: { contentType: object.contentType } }; },
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const imagePath = `/api/admin/products/${created.data.id}/images`;
  const positions = [];
  for (let index = 0; index < 6; index++) {
    const image = await rewrittenApi(imagePath, { method: 'POST', auth: true, contentType: 'image/png', rawBody: png });
    assert.equal(image.response.status, 201);
    positions.push(image.data.position);
  }
  assert.deepEqual(positions, [0, 1, 2, 3, 4, 5]);
  const seventh = await rewrittenApi(imagePath, { method: 'POST', auth: true, contentType: 'image/png', rawBody: png });
  assert.equal(seventh.response.status, 400);
  const removedImage = await rewrittenApi(`${imagePath}/${(await rewrittenApi(imagePath, { auth: true })).data[2].id}`, { method: 'DELETE', auth: true, body: {} });
  assert.equal(removedImage.response.status, 200);
  const replacementImage = await rewrittenApi(imagePath, { method: 'POST', auth: true, contentType: 'image/png', rawBody: png });
  assert.equal(replacementImage.response.status, 201);
  assert.equal(replacementImage.data.position, 2);
  assert.deepEqual((await rewrittenApi(imagePath, { auth: true })).data.map(image => image.position), [0, 1, 2, 3, 4, 5]);
  assert.throws(() => sqlDb.prepare(`INSERT INTO product_images (id, product_id, url, position, is_primary, active, created_at) VALUES (?, ?, ?, 6, 0, 1, ?)`)
    .run('out-of-range-image', created.data.id, 'https://images.example.test/x.png', new Date().toISOString()), /CHECK constraint failed/);
  assert.throws(() => sqlDb.prepare(`INSERT INTO product_images (id, product_id, url, position, is_primary, active, created_at) VALUES (?, ?, ?, 5, 0, 1, ?)`)
    .run('duplicate-position-image', created.data.id, 'https://images.example.test/y.png', new Date().toISOString()), /UNIQUE constraint failed/);
  assert.equal((await rewrittenApi(`/api/admin/products/${created.data.id}`, { method: 'DELETE', auth: true })).response.status, 200);
  assert.equal(sqlDb.prepare('SELECT COUNT(*) AS count FROM products WHERE id = ?').get(created.data.id).count, 1);
  assert.equal(sqlDb.prepare('SELECT COUNT(*) AS count FROM order_items WHERE id = ?').get('legacy-order-item').count, 1);
});
