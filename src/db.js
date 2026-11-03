import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { queryId } from './query-registry.js';

const remote = Boolean(process.env.VERCEL || process.env.D1_PROXY_URL);
let local;
const transactionContext = new AsyncLocalStorage();
const configuredPath = process.env.DATABASE_PATH || './data/daybreaker.sqlite';
export const databasePath = remote ? null : resolve(process.cwd(), configuredPath);

if (remote && (!process.env.D1_PROXY_URL || !process.env.D1_PROXY_SECRET)) {
  throw new Error('D1_PROXY_URL y D1_PROXY_SECRET son obligatorios para acceder a la base desde Vercel.');
}
if (remote) {
  const proxyUrl = new URL(process.env.D1_PROXY_URL);
  if (proxyUrl.username || proxyUrl.password || (process.env.VERCEL && proxyUrl.protocol !== 'https:')) {
    throw new Error('D1_PROXY_URL debe ser una URL HTTPS de Worker sin credenciales embebidas.');
  }
  if (process.env.D1_PROXY_SECRET.length < 32) throw new Error('D1_PROXY_SECRET debe tener al menos 32 caracteres.');
  if (process.env.VERCEL && process.env.D1_PROXY_VERIFIED !== 'true') {
    throw new Error('D1_PROXY_VERIFIED=true es obligatorio en Vercel después de probar la conexión con Cloudflare D1.');
  }
}

if (!remote) {
  mkdirSync(dirname(databasePath), { recursive: true });
  local = new DatabaseSync(databasePath);
  local.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  local.exec(`
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, short_description TEXT NOT NULL DEFAULT '', specifications TEXT NOT NULL DEFAULT '', retail_price_cents INTEGER NOT NULL CHECK (retail_price_cents > 0), availability TEXT NOT NULL CHECK (availability IN ('available','sold_out','on_request')), image_url TEXT, technical_pdf_url TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, tracking_token_hash TEXT NOT NULL, customer_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, province TEXT NOT NULL, locality TEXT NOT NULL, postal_code TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents > 0), freight_cents INTEGER CHECK (freight_cents IS NULL OR freight_cents >= 0), total_cents INTEGER NOT NULL CHECK (total_cents > 0), status TEXT NOT NULL, carrier TEXT NOT NULL DEFAULT '', shipment_tracking TEXT NOT NULL DEFAULT '', freight_accepted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), product_id TEXT, product_slug TEXT NOT NULL, product_name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0), quantity INTEGER NOT NULL CHECK (quantity > 0), line_total_cents INTEGER NOT NULL CHECK (line_total_cents > 0));
    CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, company_name TEXT NOT NULL DEFAULT '', contact_name TEXT NOT NULL DEFAULT '', cuit TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, phone TEXT NOT NULL, destination TEXT NOT NULL, items_json TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK (status IN ('pending','responded','closed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), method TEXT NOT NULL CHECK (method IN ('transfer','mercadopago')), amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), status TEXT NOT NULL CHECK (status IN ('pending_verification','pending','confirmed','failed')), provider_preference_id TEXT UNIQUE, checkout_url TEXT, provider_payment_id TEXT UNIQUE, created_at TEXT NOT NULL, confirmed_at TEXT);
    CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS order_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), event_type TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_quotes_status_created ON quotes(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id, created_at);
  `);
}

async function remoteRequest(path, payload) {
  const response = await fetch(new URL(path, process.env.D1_PROXY_URL), {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.D1_PROXY_SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `D1 proxy respondió ${response.status}`);
  return result;
}

export async function verifyConnection() {
  if (!remote) return true;
  const result = await remoteRequest('/v1/health', {});
  if (result.connected !== true) throw new Error('Cloudflare D1 no confirmó la conexión.');
  return true;
}

function statement(sql) {
  const id = queryId(sql);
  if (!id) throw new Error('Consulta SQL no registrada para D1.');
  return {
    get: async (...params) => {
      if (transactionContext.getStore()) { const item = { id, params, mode: 'get' }; transactionContext.getStore().push(item); return item; }
      if (remote) return (await remoteRequest('/v1/query', { id, params, mode: 'get' })).result;
      return local.prepare(sql).get(...params);
    },
    all: async (...params) => {
      if (transactionContext.getStore()) { const item = { id, params, mode: 'all' }; transactionContext.getStore().push(item); return item; }
      if (remote) return (await remoteRequest('/v1/query', { id, params, mode: 'all' })).results;
      return local.prepare(sql).all(...params);
    },
    run: async (...params) => {
      if (transactionContext.getStore()) { const item = { id, params, mode: 'run' }; transactionContext.getStore().push(item); return item; }
      if (remote) return (await remoteRequest('/v1/query', { id, params, mode: 'run' })).result;
      return local.prepare(sql).run(...params);
    },
  };
}

export const db = {
  prepare: statement,
  exec(sql) {
    if (!local) throw new Error('La base D1 remota no admite ejecución SQL desde el backend Vercel.');
    return local.exec(sql);
  },
  close() { local?.close(); },
};

export async function transaction(callback) {
  if (!remote) {
    local.exec('BEGIN IMMEDIATE');
    try { const result = await callback(); local.exec('COMMIT'); return result; }
    catch (error) { local.exec('ROLLBACK'); throw error; }
  }
  if (transactionContext.getStore()) throw new Error('No se permiten transacciones anidadas.');
  const statements = [];
  await transactionContext.run(statements, callback);
  if (statements.length) await remoteRequest('/v1/batch', { statements: statements.map(({ id, params }) => ({ id, params })) });
}

export function now() { return new Date().toISOString(); }

export function logOrderEvent(orderId, eventType, details = {}) {
  return db.prepare(`INSERT INTO order_events (id, order_id, event_type, details_json, created_at)
    SELECT ?, ?, ?, ?, ? WHERE changes() > 0`)
    .run(randomUUID(), orderId, eventType, JSON.stringify(details), now());
}
