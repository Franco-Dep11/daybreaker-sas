import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const databasePath = resolve('data/daybreaker-test.sqlite');
for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
process.env.DATABASE_PATH = databasePath;
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'local-development-password-32chars';
process.env.ADMIN_USER = 'daybreaker-test';
process.env.BANK_ACCOUNT_HOLDER = 'DAYBREAKER TEST';
process.env.BANK_NAME = 'Banco de prueba';
process.env.BANK_CBU = '0000000000000000000000';

const { handleRequest } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const server = createServer(handleRequest);
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const base = `http://127.0.0.1:${server.address().port}`;
const origin = base;
let cookie = '';

async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { response, data: await response.json().catch(() => null) };
}

after(async () => {
  await new Promise(resolveClose => server.close(resolveClose));
  db.close();
  for (const suffix of ['', '-shm', '-wal']) rmSync(`${databasePath}${suffix}`, { force: true });
});

test('productos, pedido, cotización, sesión, flete, seguimiento y confirmación son persistentes', async () => {
  const invalidLogin = await api('/api/admin/login', { method: 'POST', body: { username: 'usuario-incorrecto', password: process.env.ADMIN_PASSWORD } });
  assert.equal(invalidLogin.response.status, 401);
  const login = await api('/api/admin/login', { method: 'POST', body: { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.response.status, 200);
  assert.ok(cookie.startsWith('daybreaker_session='));

  const createdProduct = await api('/api/admin/products', { method: 'POST', auth: true, body: {
    name: 'Producto de prueba', slug: 'producto-prueba', retailPrice: '12500', availability: 'available',
  } });
  assert.equal(createdProduct.response.status, 201);
  let product = createdProduct.data;
  const editedProduct = await api(`/api/admin/products/${product.id}`, { method: 'PUT', auth: true, body: {
    name: 'Producto editado', slug: 'producto-prueba', retailPrice: '12500', availability: 'available',
  } });
  assert.equal(editedProduct.response.status, 200);
  product = editedProduct.data;
  assert.equal(product.name, 'Producto editado');
  assert.equal((await api('/api/catalog')).data.length, 1);

  const quote = await api('/api/quotes', { method: 'POST', body: {
    companyName: 'Comercio de prueba', email: 'test@example.com', phone: '1122334455', destination: 'Buenos Aires',
    items: [{ productId: product.id, quantity: 4 }],
  } });
  assert.equal(quote.response.status, 201);
  assert.equal((await api('/api/admin/quotes', { auth: true })).data[0].id, quote.data.id);
  assert.equal((await api(`/api/admin/quotes/${quote.data.id}/status`, { method: 'PUT', auth: true, body: { status: 'responded' } })).response.status, 200);

  const orderResult = await api('/api/orders', { method: 'POST', body: {
    customerName: 'Cliente de prueba', email: 'cliente@example.com', phone: '1122334455', address: 'Calle 123',
    province: 'Buenos Aires', locality: 'La Plata', postalCode: '1900', items: [{ productId: product.id, quantity: 2 }],
  } });
  assert.equal(orderResult.response.status, 201);
  assert.equal((await api('/api/admin/orders', { auth: true })).data[0].id, orderResult.data.id);
  const token = orderResult.data.trackingUrl.split('#')[1];
  const track = body => api('/api/track', { method: 'POST', body });
  const unaccepted = await track({ id: orderResult.data.id, token });
  assert.equal(unaccepted.data.freightAccepted, false);
  assert.equal(unaccepted.data.payments.length, 0);
  assert.equal((await api(`/api/admin/products/${product.id}`, { method: 'DELETE', auth: true })).response.status, 200);
  assert.equal((await api('/api/catalog')).data.length, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM order_items WHERE product_id = ?').get(product.id)).count, 1);
  assert.equal((await track({ id: orderResult.data.id, token })).data.items[0].name, 'Producto editado');
  const paymentBeforeFreight = await api('/api/track/payment', { method: 'POST', body: { id: orderResult.data.id, token, method: 'transfer' } });
  assert.equal(paymentBeforeFreight.response.status, 400);

  const freight = await api(`/api/admin/orders/${orderResult.data.id}/freight`, { method: 'PUT', auth: true, body: { freight: '2500', carrier: 'Transporte de prueba' } });
  assert.equal(freight.response.status, 200);
  assert.equal(freight.data.totalCents, 2750000);
  const accepted = await api('/api/track/accept-freight', { method: 'POST', body: { id: orderResult.data.id, token } });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.data.order.freightAccepted, true);

  const payment = await api('/api/track/payment', { method: 'POST', body: { id: orderResult.data.id, token, method: 'transfer' } });
  assert.equal(payment.response.status, 201);
  assert.equal(payment.data.payment.status, 'pending_verification');
  const confirmPath = `/api/admin/payments/${payment.data.payment.id}/confirm`;
  assert.equal((await api(confirmPath, { method: 'PUT', auth: true })).response.status, 200);
  const repeated = await api(confirmPath, { method: 'PUT', auth: true });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.data.alreadyConfirmed, true);

  const finalOrder = await track({ id: orderResult.data.id, token });
  assert.equal(finalOrder.data.status, 'payment_confirmed');
  assert.equal(finalOrder.data.payments[0].status, 'confirmed');
  assert.equal((await api('/api/admin/logout', { method: 'POST' })).response.status, 200);
  assert.equal((await api('/api/admin/session')).data.authenticated, false);
});

test('ADMIN_USER es opcional y usa admin por defecto', async () => {
  const configuredUser = process.env.ADMIN_USER;
  delete process.env.ADMIN_USER;
  try {
    const login = await api('/api/admin/login', { method: 'POST', body: { username: 'admin', password: process.env.ADMIN_PASSWORD } });
    assert.equal(login.response.status, 200);
  } finally {
    process.env.ADMIN_USER = configuredUser;
  }
});
