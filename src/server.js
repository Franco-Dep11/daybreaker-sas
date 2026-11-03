import { createHash, randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, logOrderEvent, now, transaction, uploadProductAsset } from './db.js';
import {
  AVAILABILITY, ORDER_STATUSES, QUOTE_STATUSES, asAmount, badRequest, email,
  makeSlug, parseMoneyCents, quantity, text,
} from './domain.js';
import { createPreference, fetchPayment, validWebhookSignature } from './payments/mercadopago.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE = 'daybreaker_session';
const SESSION_DAYS = 8;
const MAX_BODY_BYTES = 128 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length < 16) {
  console.error('ADMIN_PASSWORD debe tener al menos 16 caracteres. El panel no se iniciará con una clave débil.');
  process.exit(1);
}

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'], ['.ico', 'image/x-icon'],
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameHash(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

function providerAmountCents(value) {
  const amount = String(value ?? '');
  const match = amount.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return NaN;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : NaN;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return new URL(process.env.PUBLIC_BASE_URL).origin;
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProtocol || (req.socket.encrypted ? 'https' : 'http');
  return `${protocol}://${req.headers.host || `localhost:${PORT}`}`;
}

function configPublic() {
  const transferEnabled = Boolean(
    process.env.BANK_ACCOUNT_HOLDER && process.env.BANK_NAME && process.env.BANK_CBU,
  );
  let mercadopagoEnabled = Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN && process.env.MERCADOPAGO_WEBHOOK_SECRET && process.env.PUBLIC_BASE_URL);
  if (mercadopagoEnabled) {
    try {
      const publicUrl = new URL(process.env.PUBLIC_BASE_URL);
      if (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:') mercadopagoEnabled = false;
    } catch { mercadopagoEnabled = false; }
  }
  return {
    contactEmail: process.env.CONTACT_EMAIL || '',
    whatsappPhone: (process.env.WHATSAPP_PHONE || '').replace(/\D/g, ''),
    transferEnabled,
    mercadopagoEnabled,
    adminEnabled: Boolean(process.env.ADMIN_PASSWORD),
    readOnlyPreview: Boolean(process.env.VERCEL && process.env.D1_PROXY_VERIFIED !== 'true'),
  };
}

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    try {
      if (req.body !== undefined) {
        if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return resolveBody(req.body);
        if (Buffer.isBuffer(req.body)) return resolveBody(JSON.parse(req.body.toString('utf8')));
        if (typeof req.body === 'string') return resolveBody(JSON.parse(req.body));
      }
    } catch {
      return reject(badRequest('No se pudo leer el formulario.', 400, 'INVALID_JSON'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('El formulario supera el tamaño permitido.', 413, 'BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolveBody({});
      if (!(req.headers['content-type'] || '').includes('application/json')) {
        return reject(badRequest('La solicitud debe enviarse en formato JSON.', 415, 'UNSUPPORTED_MEDIA_TYPE'));
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('No se pudo leer el formulario.', 400, 'INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readImageBytes(req) {
  return new Promise((resolveBytes, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { reject(badRequest('Cada imagen debe pesar hasta 4 MB.', 413, 'IMAGE_TOO_LARGE')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBytes(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requireSameOrigin(req, url) {
  const origin = req.headers.origin;
  if (!origin) return;
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProtocol || (req.socket.encrypted ? 'https' : 'http');
  const expected = process.env.PUBLIC_BASE_URL
    ? new URL(process.env.PUBLIC_BASE_URL).origin
    : `${protocol}://${req.headers.host}`;
  let received;
  try { received = new URL(origin).origin; } catch { throw badRequest('Origen de solicitud no permitido.', 403, 'ORIGIN_REJECTED'); }
  if (received !== expected) throw badRequest('Origen de solicitud no permitido.', 403, 'ORIGIN_REJECTED');
}

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

async function requireAdmin(req) {
  const rawToken = cookieValue(req, SESSION_COOKIE);
  if (!rawToken) throw badRequest('Iniciá sesión para continuar.', 401, 'AUTH_REQUIRED');
  const session = await db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (!session || session.expires_at <= now()) {
    if (session) await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(rawToken));
    throw badRequest('La sesión venció. Volvé a iniciar sesión.', 401, 'AUTH_REQUIRED');
  }
}

function cookieOptions(req, maxAge) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function productRecord(row) {
  return {
    id: row.id, slug: row.slug, name: row.name,
    shortDescription: row.short_description,
    specifications: row.specifications,
    retailPriceCents: row.retail_price_cents,
    availability: row.availability,
    imageUrl: row.image_url,
    technicalPdfUrl: row.technical_pdf_url,
    active: Boolean(row.active),
    visibleInStore: Boolean(row.visible_in_store ?? row.active),
    stockQuantity: row.stock_quantity ?? 0,
    categoryId: row.category_id || '',
    subcategoryId: row.subcategory_id || '',
    attributes: JSON.parse(row.attributes_json || '[]'),
    images: JSON.parse(row.images_json || '[]'),
    categoryName: row.category_name || '',
    subcategoryName: row.subcategory_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function withProductImages(rows) {
  return Promise.all(rows.map(async row => {
    const images = await db.prepare('SELECT id, url, alt_text, position, is_primary FROM product_images WHERE product_id = ? AND active = 1 ORDER BY position').all(row.id);
    return productRecord({ ...row, images_json: JSON.stringify(images.map(image => ({ id: image.id, url: image.url, altText: image.alt_text, position: image.position, isPrimary: Boolean(image.is_primary) }))) });
  }));
}

async function orderItems(orderId) {
  return (await db.prepare(`SELECT product_id, product_slug, product_name, unit_price_cents,
    quantity, line_total_cents FROM order_items WHERE order_id = ? ORDER BY rowid`).all(orderId)).map(item => ({
    productId: item.product_id,
    slug: item.product_slug,
    name: item.product_name,
    unitPriceCents: item.unit_price_cents,
    quantity: item.quantity,
    lineTotalCents: item.line_total_cents,
  }));
}

async function validTrackingToken(orderId, token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 100) return null;
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || !sameHash(order.tracking_token_hash, sha256(token))) return null;
  return order;
}

async function publicOrder(order) {
  const paymentRows = await db.prepare(`SELECT method, status, amount_cents, checkout_url, created_at, confirmed_at
    FROM payments WHERE order_id = ? ORDER BY created_at DESC`).all(order.id);
  return {
    id: order.id,
    customerName: order.customer_name,
    email: order.email,
    phone: order.phone,
    address: order.address,
    province: order.province,
    locality: order.locality,
    postalCode: order.postal_code,
    notes: order.notes,
    subtotalCents: order.subtotal_cents,
    freightCents: order.freight_cents,
    totalCents: order.freight_cents === null ? null : order.total_cents,
    status: order.status,
    carrier: order.carrier,
    shipmentTracking: order.shipment_tracking,
    freightAccepted: Boolean(order.freight_accepted_at),
    items: await orderItems(order.id),
    payments: paymentRows.map(payment => ({
      method: payment.method, status: payment.status, amountCents: payment.amount_cents,
      checkoutUrl: payment.checkout_url || '', createdAt: payment.created_at, confirmedAt: payment.confirmed_at,
    })),
    paymentOptions: order.freight_accepted_at && order.status !== 'canceled' ? {
      transfer: configPublic().transferEnabled,
      mercadopago: configPublic().mercadopagoEnabled,
    } : { transfer: false, mercadopago: false },
    createdAt: order.created_at,
  };
}

async function adminOrder(order) {
  const payments = await db.prepare(`SELECT id, method, status, amount_cents, provider_preference_id,
    provider_payment_id, created_at, confirmed_at FROM payments WHERE order_id = ? ORDER BY created_at DESC`).all(order.id);
  return {
    ...await publicOrder(order),
    trackingTokenHash: undefined,
    payments: payments.map(payment => ({
      id: payment.id, method: payment.method, status: payment.status,
      amountCents: payment.amount_cents, providerReference: payment.provider_payment_id || payment.provider_preference_id || '',
      createdAt: payment.created_at, confirmedAt: payment.confirmed_at,
    })),
  };
}

function addProduct(body, id = randomUUID()) {
  const name = text(body.name, 'Nombre del producto', { max: 120 });
  const productSlug = makeSlug(body.slug || name);
  const description = text(body.shortDescription || '', 'Descripción', { required: false, max: 1000 });
  const specifications = text(body.specifications || '', 'Especificaciones', { required: false, max: 5000 });
  const price = parseMoneyCents(body.retailPrice, 'Precio minorista');
  const availability = text(body.availability, 'Disponibilidad', { max: 30 });
  if (!AVAILABILITY.includes(availability)) throw badRequest('Seleccioná una disponibilidad válida.');
  const imageUrl = text(body.imageUrl || '', 'Imagen', { required: false, max: 1000 });
  const pdfUrl = text(body.technicalPdfUrl || '', 'Ficha PDF', { required: false, max: 1000 });
  const stockQuantity = Number(body.stockQuantity ?? 0);
  if (!Number.isSafeInteger(stockQuantity) || stockQuantity < 0) throw badRequest('El stock debe ser un entero igual o mayor a cero.');
  const categoryId = body.categoryId ? text(body.categoryId, 'Categoría', { max: 80 }) : null;
  const subcategoryId = body.subcategoryId ? text(body.subcategoryId, 'Subcategoría', { max: 80 }) : null;
  const attributes = body.attributes ?? [];
  if (!Array.isArray(attributes) || attributes.length > 40) throw badRequest('Las especificaciones deben ser una lista de hasta 40 atributos.');
  const cleanAttributes = attributes.map(attribute => ({
    name: text(attribute.name, 'Atributo', { max: 80 }), value: text(attribute.value, 'Valor', { max: 240 }),
  })).filter(attribute => attribute.name && attribute.value);
  for (const assetUrl of [imageUrl, pdfUrl]) {
    if (assetUrl && !(/^https:\/\//i.test(assetUrl) || (assetUrl.startsWith('/') && !assetUrl.startsWith('//') && !assetUrl.includes('\\')))) {
      throw badRequest('Las imágenes y fichas deben usar HTTPS o una ruta local del sitio.');
    }
  }
  return { id, slug: productSlug, name, description, specifications, price, availability, imageUrl, pdfUrl,
    stockQuantity, categoryId, subcategoryId, attributes: cleanAttributes, visibleInStore: body.visibleInStore !== false };
}

async function getOrderOr404(id) {
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) throw badRequest('No encontramos ese pedido.', 404, 'NOT_FOUND');
  return order;
}

async function getQuoteOr404(id) {
  const quote = await db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  if (!quote) throw badRequest('No encontramos esa solicitud.', 404, 'NOT_FOUND');
  return quote;
}

async function parseQuoteItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 40) {
    throw badRequest('Agregá entre 1 y 40 productos a la consulta.');
  }
  return Promise.all(items.map(async item => {
    const amount = quantity(item.quantity);
    let productName;
    let productId = null;
    let productSlug = '';
    if (item.productId) {
      const product = await db.prepare('SELECT id, slug, name FROM products WHERE id = ? AND active = 1 AND visible_in_store = 1').get(text(item.productId, 'Producto', { max: 80 }));
      if (!product) throw badRequest('Uno de los productos elegidos ya no está disponible. Actualizá la página.');
      productName = product.name;
      productId = product.id;
      productSlug = product.slug;
    } else {
      productName = text(item.productName, 'Producto solicitado', { max: 160 });
    }
    return { productId, slug: productSlug, name: productName, quantity: amount };
  }));
}

function setupHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

async function api(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;
  const isWebhook = pathname === '/api/webhooks/mercadopago' && method === 'POST';
  if (method !== 'GET' && !isWebhook) requireSameOrigin(req, url);

  if (method === 'GET' && pathname === '/api/config') return json(res, 200, configPublic());
  if (method === 'GET' && pathname === '/api/catalog') {
    const rows = (await db.prepare('SELECT * FROM products WHERE active = 1 AND visible_in_store = 1 ORDER BY name COLLATE NOCASE').all());
    return json(res, 200, await withProductImages(rows));
  }
  if (method === 'GET' && pathname.startsWith('/api/products/')) {
    const slugValue = decodeURIComponent(pathname.slice('/api/products/'.length));
    const product = (await db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1 AND visible_in_store = 1').get(slugValue));
    if (!product) return json(res, 404, { error: 'No encontramos ese producto.', code: 'NOT_FOUND' });
    return json(res, 200, (await withProductImages([product]))[0]);
  }

  if (method === 'POST' && pathname === '/api/orders') {
    const body = await readBody(req);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 40) throw badRequest('El carrito está vacío o tiene demasiados productos.');
    const customer = {
      name: text(body.customerName, 'Nombre', { max: 120 }),
      email: email(body.email),
      phone: text(body.phone, 'Teléfono', { max: 80 }),
      address: text(body.address, 'Domicilio', { max: 240 }),
      province: text(body.province, 'Provincia', { max: 120 }),
      locality: text(body.locality, 'Localidad', { max: 120 }),
      postalCode: text(body.postalCode, 'Código postal', { max: 24 }),
      notes: text(body.notes || '', 'Observaciones', { required: false, max: 1000 }),
    };
    const itemMap = new Map();
    for (const raw of body.items) {
      const productId = text(raw.productId, 'Producto', { max: 80 });
      const amount = quantity(raw.quantity);
      itemMap.set(productId, (itemMap.get(productId) || 0) + amount);
    }
    const items = [];
    for (const [productId, amount] of itemMap) {
      const product = (await db.prepare(`SELECT id, slug, name, retail_price_cents, availability
        FROM products WHERE id = ? AND active = 1 AND visible_in_store = 1`).get(productId));
      if (!product || product.availability !== 'available') throw badRequest('Un producto del carrito ya no se puede comprar. Actualizá el catálogo.');
      if (amount > 9999) throw badRequest('La cantidad de un producto supera el máximo permitido.');
      items.push({ ...product, quantity: amount, lineTotalCents: product.retail_price_cents * amount });
    }
    const subtotal = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    if (!Number.isSafeInteger(subtotal) || subtotal <= 0) throw badRequest('No se pudo calcular el importe del carrito.');
    const id = randomBytes(12).toString('hex');
    const token = randomBytes(32).toString('base64url');
    const timestamp = now();
    await transaction(async () => {
      (await db.prepare(`INSERT INTO orders (id, tracking_token_hash, customer_name, email, phone, address, province,
        locality, postal_code, notes, subtotal_cents, freight_cents, total_cents, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'received', ?, ?)`)
        .run(id, sha256(token), customer.name, customer.email, customer.phone, customer.address,
          customer.province, customer.locality, customer.postalCode, customer.notes, subtotal, subtotal, timestamp, timestamp));
      const insertItem = db.prepare(`INSERT INTO order_items (id, order_id, product_id, product_slug, product_name,
        unit_price_cents, quantity, line_total_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const item of items) insertItem.run(randomUUID(), id, item.id, item.slug, item.name,
        item.retail_price_cents, item.quantity, item.lineTotalCents);
      logOrderEvent(id, 'received', { subtotalCents: subtotal });
    });
    return json(res, 201, {
      id,
      subtotalCents: subtotal,
      freightPending: true,
      trackingUrl: `/seguimiento/${id}#${token}`,
      message: 'Recibimos tu pedido. DAYBREAKER cotizará el flete y te enviará el total para que lo aceptes antes de pagar.',
    });
  }

  if (method === 'POST' && pathname === '/api/quotes') {
    const body = await readBody(req);
    const company = text(body.companyName || '', 'Razón social', { required: false, max: 180 });
    const contact = text(body.contactName || '', 'Nombre de contacto', { required: false, max: 120 });
    if (!company && !contact) throw badRequest('Indicá la razón social o el nombre de contacto.');
    const phone = text(body.phone, 'Teléfono', { max: 80 });
    const destination = text(body.destination, 'Destino', { max: 240 });
    const items = await parseQuoteItems(body.items);
    const id = randomBytes(8).toString('hex').toUpperCase();
    const timestamp = now();
    (await db.prepare(`INSERT INTO quotes (id, company_name, contact_name, cuit, email, phone, destination,
      items_json, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, company, contact, text(body.cuit || '', 'CUIT', { required: false, max: 16 }), email(body.email), phone,
        destination, JSON.stringify(items), text(body.notes || '', 'Observaciones', { required: false, max: 1200 }), timestamp, timestamp));
    return json(res, 201, { id, createdAt: timestamp, message: 'Tu solicitud quedó registrada. DAYBREAKER te responderá por email o WhatsApp.' });
  }

  if (method === 'POST' && pathname === '/api/track') {
    const body = await readBody(req);
    const order = await validTrackingToken(text(body.id, 'Código de pedido', { max: 32 }), body.token);
    if (!order) throw badRequest('El enlace de seguimiento no es válido. Usá el enlace completo que recibiste.', 404, 'TRACKING_NOT_FOUND');
    return json(res, 200, await publicOrder(order));
  }

  if (method === 'POST' && pathname === '/api/track/accept-freight') {
    const body = await readBody(req);
    const order = await validTrackingToken(text(body.id, 'Código de pedido', { max: 32 }), body.token);
    if (!order) throw badRequest('El enlace de seguimiento no es válido.', 404, 'TRACKING_NOT_FOUND');
    if (order.status !== 'freight_quoted' || order.freight_cents === null) throw badRequest('Todavía no hay un flete listo para aceptar.');
    await transaction(async () => {
      const acceptedAt = now();
      (await db.prepare(`UPDATE orders SET status = 'awaiting_payment', freight_accepted_at = ?, updated_at = ? WHERE id = ? AND status = 'freight_quoted' AND freight_cents IS NOT NULL`)
        .run(acceptedAt, acceptedAt, order.id));
      logOrderEvent(order.id, 'freight_accepted', { totalCents: order.total_cents });
    });
    const acceptedOrder = await getOrderOr404(order.id);
    if (acceptedOrder.status !== 'awaiting_payment' || !acceptedOrder.freight_accepted_at) throw badRequest('El pedido cambi? mientras aceptabas el flete. Actualiz? el seguimiento.', 409, 'ORDER_STATE_CHANGED');
    return json(res, 200, { message: 'Total aceptado. Ya podés elegir un medio de pago.', order: await publicOrder(acceptedOrder) });
  }

  if (method === 'POST' && pathname === '/api/track/payment') {
    const body = await readBody(req);
    const order = await validTrackingToken(text(body.id, 'Código de pedido', { max: 32 }), body.token);
    if (!order) throw badRequest('El enlace de seguimiento no es válido.', 404, 'TRACKING_NOT_FOUND');
    if (order.status !== 'awaiting_payment' || !order.freight_accepted_at || order.freight_cents === null) {
      throw badRequest('Primero aceptá el total con flete cotizado.');
    }
    const methodName = text(body.method, 'Medio de pago', { max: 24 });
    if (!['transfer', 'mercadopago'].includes(methodName)) throw badRequest('Elegí un medio de pago disponible.');
    const existing = (await db.prepare(`SELECT * FROM payments WHERE order_id = ? AND method = ? ORDER BY created_at DESC LIMIT 1`)
      .get(order.id, methodName));
    if (existing && existing.status !== 'failed') {
      return json(res, 200, {
        payment: { id: existing.id, method: existing.method, status: existing.status, amountCents: existing.amount_cents },
        checkoutUrl: existing.checkout_url || '',
        bankDetails: methodName === 'transfer' ? bankDetails() : null,
        order: await publicOrder(order),
      });
    }
    const paymentId = randomUUID();
    const timestamp = now();
    if (methodName === 'transfer') {
      if (!configPublic().transferEnabled) throw badRequest('La cuenta bancaria de DAYBREAKER todavía no está configurada.', 503, 'PAYMENT_NOT_CONFIGURED');
      await transaction(async () => {
        (await db.prepare(`INSERT INTO payments (id, order_id, method, amount_cents, status, created_at)
          VALUES (?, ?, 'transfer', ?, 'pending_verification', ?)`)
          .run(paymentId, order.id, order.total_cents, timestamp));
        logOrderEvent(order.id, 'transfer_instructions_shown', { amountCents: order.total_cents });
      });
      return json(res, 201, {
        payment: { id: paymentId, method: methodName, status: 'pending_verification', amountCents: order.total_cents },
        bankDetails: bankDetails(),
        order: await publicOrder(await getOrderOr404(order.id)),
      });
    }

    if (!configPublic().mercadopagoEnabled) throw badRequest('Mercado Pago todavía no está configurado para la cuenta de DAYBREAKER.', 503, 'PAYMENT_NOT_CONFIGURED');
    const items = (await db.prepare(`SELECT product_slug, product_name, unit_price_cents, quantity
      FROM order_items WHERE order_id = ? ORDER BY rowid`).all(order.id));
    const preference = await createPreference(order, items);
    await transaction(async () => {
      (await db.prepare(`INSERT INTO payments (id, order_id, method, amount_cents, status, provider_preference_id,
        checkout_url, created_at) VALUES (?, ?, 'mercadopago', ?, 'pending', ?, ?, ?)`)
        .run(paymentId, order.id, order.total_cents, preference.id, preference.url, timestamp));
      logOrderEvent(order.id, 'mercadopago_checkout_created', { amountCents: order.total_cents });
    });
    return json(res, 201, {
      payment: { id: paymentId, method: methodName, status: 'pending', amountCents: order.total_cents },
      checkoutUrl: preference.url,
      order: await publicOrder(await getOrderOr404(order.id)),
    });
  }

  if (method === 'POST' && pathname === '/api/admin/login') {
    if (!process.env.ADMIN_PASSWORD) throw badRequest('Configurá ADMIN_PASSWORD en el archivo .env para habilitar el panel.', 503, 'ADMIN_NOT_CONFIGURED');
    const ip = req.socket.remoteAddress || 'unknown';
    const attempts = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (attempts.until > Date.now() && attempts.count >= 8) throw badRequest('Demasiados intentos. Esperá 15 minutos y volvé a intentar.', 429, 'LOGIN_THROTTLED');
    if (attempts.until <= Date.now()) loginAttempts.set(ip, { count: 0, until: Date.now() + LOGIN_WINDOW_MS });
    const body = await readBody(req);
    const candidate = text(body.password, 'Contraseña', { max: 256 });
    const salt = Buffer.from('daybreaker-admin-login-v1', 'utf8');
    const expected = scryptSync(process.env.ADMIN_PASSWORD, salt, 32);
    const received = scryptSync(candidate, salt, 32);
    if (!timingSafeEqual(expected, received)) {
      const current = loginAttempts.get(ip) || { count: 0, until: Date.now() + LOGIN_WINDOW_MS };
      current.count += 1;
      loginAttempts.set(ip, current);
      throw badRequest('La contraseña no es correcta.', 401, 'INVALID_CREDENTIALS');
    }
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    (await db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now()));
    (await db.prepare('INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)').run(sha256(token), expires, now()));
    return json(res, 200, { authenticated: true }, {
      'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    });
  }

  if (method === 'GET' && pathname === '/api/admin/session') {
    try { await requireAdmin(req); return json(res, 200, { authenticated: true }); }
    catch { return json(res, 200, { authenticated: false }); }
  }
  if (method === 'POST' && pathname === '/api/admin/logout') {
    const token = cookieValue(req, SESSION_COOKIE);
    if (token) (await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token)));
    return json(res, 200, { authenticated: false }, { 'Set-Cookie': cookieOptions(req, 0) });
  }

  if (pathname.startsWith('/api/admin/')) await requireAdmin(req);

  if (method === 'GET' && pathname === '/api/admin/categories') {
    const categories = await db.prepare('SELECT id, name, slug FROM categories ORDER BY name COLLATE NOCASE').all();
    const subcategories = await db.prepare('SELECT id, category_id, name, slug FROM subcategories ORDER BY name COLLATE NOCASE').all();
    return json(res, 200, categories.map(category => ({ ...category, subcategories: subcategories.filter(item => item.category_id === category.id).map(item => ({ id: item.id, name: item.name, slug: item.slug })) })));
  }
  if (method === 'POST' && pathname === '/api/admin/categories') {
    const body = await readBody(req);
    const name = text(body.name, 'Nombre de categoría', { max: 100 });
    if (await db.prepare('SELECT id FROM categories WHERE name = ?').get(name)) throw badRequest('Ya existe una categoria con ese nombre.', 409, 'CATEGORY_EXISTS');
    const base = makeSlug(name);
    let slug = base; let suffix = 2;
    while (await db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug)) slug = `${base}-${suffix++}`;
    const id = randomUUID(); const timestamp = now();
    await db.prepare('INSERT INTO categories (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, slug, timestamp, timestamp);
    return json(res, 201, { id, name, slug, subcategories: [] });
  }
  const subcategoryRoute = pathname.match(/^\/api\/admin\/categories\/([a-f0-9-]+)\/subcategories$/i);
  if (subcategoryRoute && method === 'POST') {
    const body = await readBody(req);
    const category = await db.prepare('SELECT id FROM categories WHERE id = ?').get(subcategoryRoute[1]);
    if (!category) throw badRequest('No encontramos esa categoría.', 404, 'NOT_FOUND');
    const name = text(body.name, 'Nombre de subcategoría', { max: 100 });
    if (await db.prepare('SELECT id FROM subcategories WHERE category_id = ? AND name = ?').get(category.id, name)) throw badRequest('Ya existe una subcategoria con ese nombre.', 409, 'SUBCATEGORY_EXISTS');
    const base = makeSlug(name); let slug = base; let suffix = 2;
    while (await db.prepare('SELECT id FROM subcategories WHERE category_id = ? AND slug = ?').get(category.id, slug)) slug = `${base}-${suffix++}`;
    const id = randomUUID(); const timestamp = now();
    await db.prepare('INSERT INTO subcategories (id, category_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, category.id, name, slug, timestamp, timestamp);
    return json(res, 201, { id, categoryId: category.id, name, slug });
  }

  if (method === 'GET' && pathname === '/api/admin/products') {
    return json(res, 200, await withProductImages(await db.prepare(`SELECT p.*, c.name AS category_name, s.name AS subcategory_name FROM products p
      LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN subcategories s ON s.id = p.subcategory_id
      ORDER BY p.active DESC, p.name COLLATE NOCASE`).all()));
  }
  if (method === 'POST' && pathname === '/api/admin/products') {
    const body = await readBody(req);
    const product = addProduct(body);
    if (product.categoryId && !await db.prepare('SELECT id FROM categories WHERE id = ?').get(product.categoryId)) throw badRequest('Seleccioná una categoría válida.');
    if (product.subcategoryId && !await db.prepare('SELECT id FROM subcategories WHERE id = ? AND category_id = ?').get(product.subcategoryId, product.categoryId)) throw badRequest('La subcategoría no corresponde a la categoría elegida.');
    const base = product.slug; let slug = base; let suffix = 2;
    while (await db.prepare('SELECT id FROM products WHERE slug = ?').get(slug)) slug = `${base}-${suffix++}`;
    const timestamp = now();
    await db.prepare(`INSERT INTO products (id, slug, name, short_description, specifications, retail_price_cents,
      availability, image_url, technical_pdf_url, active, visible_in_store, stock_quantity, category_id, subcategory_id, attributes_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .run(product.id, slug, product.name, product.description, product.specifications, product.price,
        product.availability, product.imageUrl || null, product.pdfUrl || null, product.visibleInStore ? 1 : 0,
        product.stockQuantity, product.categoryId, product.subcategoryId, JSON.stringify(product.attributes), timestamp, timestamp);
    return json(res, 201, productRecord((await db.prepare('SELECT * FROM products WHERE id = ?').get(product.id))));
  }
  const imageCollectionRoute = pathname.match(/^\/api\/admin\/products\/([a-f0-9-]+)\/images$/i);
  if (imageCollectionRoute && method === 'GET') {
    const images = await db.prepare('SELECT id, url, alt_text, position, is_primary FROM product_images WHERE product_id = ? AND active = 1 ORDER BY position').all(imageCollectionRoute[1]);
    return json(res, 200, images.map(image => ({ ...image, altText: image.alt_text, isPrimary: Boolean(image.is_primary) })));
  }
  if (imageCollectionRoute && method === 'POST') {
    const product = await db.prepare('SELECT id, name FROM products WHERE id = ? AND active = 1').get(imageCollectionRoute[1]);
    if (!product) throw badRequest('No encontramos ese producto activo.', 404, 'NOT_FOUND');
    const existing = await db.prepare('SELECT COUNT(*) AS count FROM product_images WHERE product_id = ? AND active = 1').get(product.id);
    if (existing.count >= 6) throw badRequest('Cada producto puede tener hasta seis imágenes.');
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw badRequest('Usá imágenes JPEG, PNG o WebP.', 415, 'UNSUPPORTED_MEDIA_TYPE');
    const bytes = await readImageBytes(req);
    const stored = await uploadProductAsset(product.id, bytes, contentType);
    const id = randomUUID(); const timestamp = now(); const primary = existing.count === 0;
    await transaction(async () => {
      await db.prepare(`INSERT INTO product_images (id, product_id, url, object_key, alt_text, position, is_primary, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(id, product.id, stored.url, stored.key, product.name, existing.count, primary ? 1 : 0, timestamp);
      if (primary) await db.prepare('UPDATE products SET image_url = ?, updated_at = ? WHERE id = ?').run(stored.url, timestamp, product.id);
    });
    return json(res, 201, { id, url: stored.url, altText: product.name, position: existing.count, isPrimary: primary });
  }
  const imageRoute = pathname.match(/^\/api\/admin\/products\/([a-f0-9-]+)\/images\/([a-f0-9-]+)$/i);
  if (imageRoute && method === 'PUT') {
    const image = await db.prepare('SELECT id, url FROM product_images WHERE id = ? AND product_id = ? AND active = 1').get(imageRoute[2], imageRoute[1]);
    if (!image) throw badRequest('No encontramos esa imagen.', 404, 'NOT_FOUND');
    await transaction(async () => {
      await db.prepare('UPDATE product_images SET is_primary = 0 WHERE product_id = ? AND is_primary = 1').run(imageRoute[1]);
      await db.prepare('UPDATE product_images SET is_primary = 1 WHERE id = ? AND product_id = ? AND active = 1').run(imageRoute[2], imageRoute[1]);
      await db.prepare('UPDATE products SET image_url = ?, updated_at = ? WHERE id = ?').run(image.url, now(), imageRoute[1]);
    });
    return json(res, 200, { primary: true });
  }
  if (imageRoute && method === 'DELETE') {
    const image = await db.prepare('SELECT id, is_primary FROM product_images WHERE id = ? AND product_id = ? AND active = 1').get(imageRoute[2], imageRoute[1]);
    if (!image) throw badRequest('No encontramos esa imagen.', 404, 'NOT_FOUND');
    const timestamp = now();
    await transaction(async () => {
      await db.prepare('UPDATE product_images SET active = 0, is_primary = 0 WHERE id = ? AND product_id = ?').run(imageRoute[2], imageRoute[1]);
      if (image.is_primary) {
        await db.prepare('UPDATE product_images SET is_primary = 1 WHERE id = (SELECT id FROM product_images WHERE product_id = ? AND active = 1 ORDER BY position LIMIT 1)').run(imageRoute[1]);
        await db.prepare('UPDATE products SET image_url = (SELECT url FROM product_images WHERE product_id = ? AND active = 1 AND is_primary = 1 LIMIT 1), updated_at = ? WHERE id = ?').run(imageRoute[1], timestamp, imageRoute[1]);
      }
    });
    return json(res, 200, { removed: true });
  }
  const productRoute = pathname.match(/^\/api\/admin\/products\/([a-f0-9-]+)$/i);
  if (productRoute && method === 'PUT') {
    const body = await readBody(req);
    const current = (await db.prepare('SELECT * FROM products WHERE id = ?').get(productRoute[1]));
    if (!current) throw badRequest('No encontramos ese producto.', 404, 'NOT_FOUND');
    const product = addProduct({
      ...body, slug: current.slug,
      imageUrl: body.imageUrl ?? current.image_url ?? '',
      technicalPdfUrl: body.technicalPdfUrl ?? current.technical_pdf_url ?? '',
    }, productRoute[1]);
    if (product.categoryId && !await db.prepare('SELECT id FROM categories WHERE id = ?').get(product.categoryId)) throw badRequest('Seleccioná una categoría válida.');
    if (product.subcategoryId && !await db.prepare('SELECT id FROM subcategories WHERE id = ? AND category_id = ?').get(product.subcategoryId, product.categoryId)) throw badRequest('La subcategoría no corresponde a la categoría elegida.');
    const timestamp = now();
    const result = (await db.prepare(`UPDATE products SET name = ?, short_description = ?, specifications = ?,
      retail_price_cents = ?, availability = ?, image_url = ?, technical_pdf_url = ?, active = ?, visible_in_store = ?, stock_quantity = ?,
      category_id = ?, subcategory_id = ?, attributes_json = ?, updated_at = ? WHERE id = ?`)
      .run(product.name, product.description, product.specifications, product.price, product.availability,
        product.imageUrl || null, product.pdfUrl || null, body.active === false ? 0 : 1, product.visibleInStore ? 1 : 0,
        product.stockQuantity, product.categoryId, product.subcategoryId, JSON.stringify(product.attributes), timestamp, product.id));
    if (!result.changes) throw badRequest('No encontramos ese producto.', 404, 'NOT_FOUND');
    return json(res, 200, productRecord((await db.prepare('SELECT * FROM products WHERE id = ?').get(product.id))));
  }
  if (productRoute && method === 'DELETE') {
    const result = (await db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(now(), productRoute[1]));
    if (!result.changes) throw badRequest('No encontramos ese producto.', 404, 'NOT_FOUND');
    return json(res, 200, { archived: true });
  }

  if (method === 'GET' && pathname === '/api/admin/orders') {
    const rows = (await db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all());
    return json(res, 200, await Promise.all(rows.map(adminOrder)));
  }
  const freightRoute = pathname.match(/^\/api\/admin\/orders\/([a-f0-9]+)\/freight$/i);
  if (freightRoute && method === 'PUT') {
    const body = await readBody(req);
    const order = await getOrderOr404(freightRoute[1]);
    if (['canceled', 'delivered', 'preparing', 'dispatched', 'payment_confirmed'].includes(order.status)) {
      throw badRequest('No se puede modificar el flete en el estado actual del pedido.');
    }
    const hasPayments = (await db.prepare(`SELECT 1 FROM payments WHERE order_id = ? AND status <> 'failed' LIMIT 1`).get(order.id));
    if (hasPayments) throw badRequest('El pedido ya tiene un intento de pago. Contactá al cliente antes de cambiar el total.');
    const freight = parseMoneyCents(body.freight, 'Flete');
    const total = order.subtotal_cents + freight;
    if (!Number.isSafeInteger(total)) throw badRequest('El total supera el límite permitido.');
    const carrier = text(body.carrier || '', 'Transportista', { required: false, max: 120 });
    const shipmentTracking = text(body.shipmentTracking || '', 'Seguimiento', { required: false, max: 180 });
    const timestamp = now();
    await transaction(async () => {
      (await db.prepare(`UPDATE orders SET freight_cents = ?, total_cents = ?, status = 'freight_quoted',
        freight_accepted_at = NULL, carrier = ?, shipment_tracking = ?, updated_at = ? WHERE id = ? AND status = ?
        AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = ? AND status <> 'failed')`)
        .run(freight, total, carrier, shipmentTracking, timestamp, order.id, order.status, order.id));
      logOrderEvent(order.id, 'freight_quoted', { freightCents: freight, totalCents: total, carrier });
    });
    const quotedOrder = await getOrderOr404(order.id);
    if (quotedOrder.status !== 'freight_quoted' || quotedOrder.freight_cents !== freight) throw badRequest('El pedido cambi? mientras actualizabas el flete. Volv? a cargarlo.', 409, 'ORDER_STATE_CHANGED');
    return json(res, 200, await adminOrder(quotedOrder));
  }

  const orderStatusRoute = pathname.match(/^\/api\/admin\/orders\/([a-f0-9]+)\/status$/i);
  if (orderStatusRoute && method === 'PUT') {
    const body = await readBody(req);
    const order = await getOrderOr404(orderStatusRoute[1]);
    const status = text(body.status, 'Estado', { max: 40 });
    if (!ORDER_STATUSES.includes(status)) throw badRequest('Seleccioná un estado válido.');
    if (['payment_confirmed', 'received', 'freight_quoted', 'awaiting_payment'].includes(status)) {
      throw badRequest('Ese estado se actualiza desde el flujo de pago o flete.');
    }
    const allowedTransitions = {
      received: ['canceled'],
      freight_quoted: ['canceled'],
      awaiting_payment: ['canceled'],
      payment_confirmed: ['preparing'],
      preparing: ['dispatched'],
      dispatched: ['delivered'],
    };
    if (!allowedTransitions[order.status]?.includes(status)) {
      throw badRequest('Ese cambio de estado no está permitido desde el estado actual.');
    }
    if (status === 'canceled') {
      const activePayment = (await db.prepare(`SELECT 1 FROM payments WHERE order_id = ? AND status <> 'failed' LIMIT 1`).get(order.id));
      if (activePayment || ['payment_confirmed', 'preparing', 'dispatched', 'delivered'].includes(order.status)) {
        throw badRequest('El pedido tiene un pago iniciado o confirmado. Resolvé ese pago antes de cancelarlo.');
      }
    }
    const timestamp = now();
    await transaction(async () => {
      (await db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(status, timestamp, order.id, order.status));
      logOrderEvent(order.id, status, { source: 'admin' });
    });
    const updatedOrder = await getOrderOr404(order.id);
    if (updatedOrder.status !== status) throw badRequest('El pedido cambiÃ³ antes de guardar el estado. VolvÃ© a cargarlo.', 409, 'ORDER_STATE_CHANGED');
    return json(res, 200, await adminOrder(updatedOrder));
  }

  if (method === 'GET' && pathname === '/api/admin/quotes') {
    const rows = (await db.prepare('SELECT * FROM quotes ORDER BY created_at DESC LIMIT 500').all());
    return json(res, 200, rows.map(quote => ({
      id: quote.id, companyName: quote.company_name, contactName: quote.contact_name,
      cuit: quote.cuit, email: quote.email, phone: quote.phone, destination: quote.destination,
      items: JSON.parse(quote.items_json), notes: quote.notes, status: quote.status,
      createdAt: quote.created_at, updatedAt: quote.updated_at,
    })));
  }
  const quoteRoute = pathname.match(/^\/api\/admin\/quotes\/([A-F0-9]+)\/status$/i);
  if (quoteRoute && method === 'PUT') {
    const body = await readBody(req);
    const quote = await getQuoteOr404(quoteRoute[1]);
    const status = text(body.status, 'Estado', { max: 24 });
    if (!QUOTE_STATUSES.includes(status)) throw badRequest('Seleccioná un estado válido.');
    (await db.prepare('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), quote.id));
    return json(res, 200, { id: quote.id, status });
  }

  const paymentConfirmRoute = pathname.match(/^\/api\/admin\/payments\/([a-f0-9-]+)\/confirm$/i);
  if (paymentConfirmRoute && method === 'PUT') {
    const payment = (await db.prepare(`SELECT p.*, o.status AS order_status FROM payments p
      JOIN orders o ON o.id = p.order_id WHERE p.id = ?`).get(paymentConfirmRoute[1]));
    if (!payment) throw badRequest('No encontramos ese pago.', 404, 'NOT_FOUND');
    if (payment.method === 'transfer' && payment.status === 'confirmed') {
      return json(res, 200, { confirmed: true, alreadyConfirmed: true });
    }
    if (payment.method !== 'transfer' || payment.status !== 'pending_verification') {
      throw badRequest('Solo se puede confirmar manualmente una transferencia pendiente de verificar.');
    }
    if (payment.order_status === 'canceled') throw badRequest('No se puede confirmar el pago de un pedido cancelado.');
    const timestamp = now();
    await transaction(async () => {
      (await db.prepare(`UPDATE payments SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending_verification'
        AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'awaiting_payment' AND freight_accepted_at IS NOT NULL)`)
        .run(timestamp, payment.id, payment.order_id));
      (await db.prepare(`UPDATE orders SET status = 'payment_confirmed', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'
        AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = 'confirmed')`)
        .run(timestamp, payment.order_id, payment.id));
      logOrderEvent(payment.order_id, 'payment_confirmed', { method: 'transfer', amountCents: payment.amount_cents });
    });
    const confirmedOrder = await getOrderOr404(payment.order_id);
    if (confirmedOrder.status !== 'payment_confirmed') throw badRequest('El pedido cambi? y el pago no se pudo confirmar. Revis? el estado antes de reintentar.', 409, 'PAYMENT_STATE_CHANGED');
    return json(res, 200, { confirmed: true });
  }

  if (isWebhook) return await handleMercadoPagoWebhook(req, res, url);
  return json(res, 404, { error: 'No encontramos ese recurso.', code: 'NOT_FOUND' });
}

function bankDetails() {
  return {
    accountHolder: process.env.BANK_ACCOUNT_HOLDER || '',
    bankName: process.env.BANK_NAME || '',
    cbu: process.env.BANK_CBU || '',
    alias: process.env.BANK_ALIAS || '',
    cuit: process.env.BANK_CUIT || '',
  };
}

async function handleMercadoPagoWebhook(req, res, url) {
  req.resume();
  const dataId = url.searchParams.get('data.id') || '';
  const valid = validWebhookSignature({
    signature: req.headers['x-signature'],
    requestId: req.headers['x-request-id'],
    dataId,
    secret: process.env.MERCADOPAGO_WEBHOOK_SECRET,
  });
  if (!valid) return json(res, 401, { error: 'Firma de notificación inválida.', code: 'INVALID_SIGNATURE' });
  const topic = url.searchParams.get('type') || url.searchParams.get('topic') || '';
  if (topic && topic !== 'payment') return json(res, 200, { received: true });
  if (!/^\d+$/.test(dataId)) return json(res, 400, { error: 'Identificador de pago inválido.', code: 'INVALID_PAYMENT_ID' });
  let remote;
  try { remote = await fetchPayment(dataId); }
  catch (error) {
    console.error('No se pudo consultar el pago notificado:', error.message);
    return json(res, 503, { error: 'No se pudo verificar el pago con Mercado Pago.' });
  }
  if (remote.currency_id !== 'ARS' || !remote.external_reference) return json(res, 200, { received: true });
  const payment = (await db.prepare(`SELECT p.*, o.total_cents, o.status AS order_status
    FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.provider_preference_id = ? AND p.order_id = ? AND p.method = 'mercadopago'`)
    .get(String(remote.preference_id || ''), String(remote.external_reference)));
  if (!payment) return json(res, 200, { received: true });
  if (payment.status === 'confirmed') return json(res, 200, { received: true });
  const remoteCents = providerAmountCents(remote.transaction_amount);
  if (!Number.isSafeInteger(remoteCents) || remoteCents !== payment.amount_cents || remoteCents !== payment.total_cents) {
    console.error('El importe notificado por Mercado Pago no coincide con el pedido:', payment.order_id);
    return json(res, 200, { received: true });
  }
  if (remote.status === 'approved' && payment.order_status !== 'canceled') {
    const timestamp = now();
    await transaction(async () => {
      (await db.prepare(`UPDATE payments SET status = 'confirmed', provider_payment_id = ?, confirmed_at = ? WHERE id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND freight_accepted_at IS NOT NULL AND freight_cents IS NOT NULL AND status IN ('awaiting_payment','freight_quoted'))`)
        .run(String(remote.id), timestamp, payment.id, payment.order_id));
      (await db.prepare(`UPDATE orders SET status = 'payment_confirmed', updated_at = ? WHERE id = ? AND freight_accepted_at IS NOT NULL AND freight_cents IS NOT NULL AND status IN ('awaiting_payment','freight_quoted')
        AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = 'confirmed')`)
        .run(timestamp, payment.order_id, payment.id));
      logOrderEvent(payment.order_id, 'payment_confirmed', { method: 'mercadopago', amountCents: remoteCents });
    });
  } else if (['rejected', 'cancelled'].includes(remote.status)) {
    (await db.prepare(`UPDATE payments SET status = 'failed', provider_payment_id = ? WHERE id = ?`)
      .run(String(remote.id), payment.id));
  }
  return json(res, 200, { received: true });
}

async function serveIndex(req, res, pathname) {
  let html = readFileSync(resolve(PUBLIC_DIR, 'index.html'), 'utf8');
  if (pathname.startsWith('/seguimiento/') || pathname.startsWith('/pago/')) {
    const title = pathname.startsWith('/seguimiento/') ? 'Seguimiento privado | DAYBREAKER SAS' : 'Estado de pago | DAYBREAKER SAS';
    html = html
      .replace('<title>DAYBREAKER SAS | Comercial</title>', `<title>${escapeHtml(title)}</title>`)
      .replace('<!--product-canonical-->', '<meta name="robots" content="noindex,nofollow">');
  }
  const pages = {
    '/': ['DAYBREAKER SAS | Inicio', 'Catálogo minorista y presupuestos mayoristas de DAYBREAKER SAS para toda Argentina.'],
    '/index.html': ['DAYBREAKER SAS | Inicio', 'Catálogo minorista y presupuestos mayoristas de DAYBREAKER SAS para toda Argentina.'],
    '/quienes-somos': ['Quiénes somos | DAYBREAKER SAS', 'Conocé el canal comercial de DAYBREAKER SAS para compras minoristas y consultas mayoristas en Argentina.'],
    '/catalogo': ['Catálogo | DAYBREAKER SAS', 'Consultá el catálogo minorista de DAYBREAKER SAS, precios en pesos argentinos y disponibilidad de productos.'],
    '/presupuestos-mayoristas': ['Presupuestos mayoristas | DAYBREAKER SAS', 'Solicitá un presupuesto mayorista de DAYBREAKER SAS con productos, cantidades y destino.'],
    '/carrito': ['Carrito y seguimiento | DAYBREAKER SAS', 'Armá tu pedido minorista y consultá su estado con tu enlace privado de seguimiento.'],
    '/contacto': ['Contacto | DAYBREAKER SAS', 'Contactá a DAYBREAKER SAS por consultas comerciales, compras minoristas y presupuestos mayoristas.'],
  };
  const page = pages[pathname];
  if (page) {
    const [title, description] = page;
    const canonical = `${publicBaseUrl(req)}${pathname === '/index.html' ? '/' : pathname}`;
    html = html
      .replace('<title>DAYBREAKER SAS | Comercial</title>', `<title>${escapeHtml(title)}</title>`)
      .replace('content="Catálogo minorista y presupuestos mayoristas de DAYBREAKER SAS para toda Argentina."', `content="${escapeHtml(description)}"`)
      .replace('<!--product-canonical-->', `<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}">`);
  }
  const match = pathname.match(/^\/productos\/([a-z0-9-]+)$/i);
  if (match) {
    const product = (await db.prepare('SELECT name, short_description, slug FROM products WHERE slug = ? AND active = 1 AND visible_in_store = 1').get(match[1]));
    if (!product) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html.replace('<title>DAYBREAKER SAS | Comercial</title>', '<title>Producto no encontrado | DAYBREAKER SAS</title>'));
    }
    const title = `${product.name} | DAYBREAKER SAS`;
    const description = product.short_description || `Consultá precio minorista, disponibilidad y cotización mayorista de ${product.name}.`;
    const canonical = `${publicBaseUrl(req)}/productos/${encodeURIComponent(product.slug)}`;
    html = html
      .replace('<title>DAYBREAKER SAS | Comercial</title>', `<title>${escapeHtml(title)}</title>`)
      .replace('content="Catálogo minorista y presupuestos mayoristas de DAYBREAKER SAS para toda Argentina."', `content="${escapeHtml(description)}"`)
      .replace('<!--product-canonical-->', `<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}">`);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function staticFile(res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + sep) && file !== resolve(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); return res.end();
  }
  if (!existsSync(file)) { res.writeHead(404); return res.end('No encontrado'); }
  res.writeHead(200, {
    'Content-Type': contentTypes.get(extname(file).toLowerCase()) || 'application/octet-stream',
    'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(res);
}

export async function handleRequest(req, res) {
  setupHeaders(res);
  const host = req.headers.host || `localhost:${PORT}`;
  let url;
  try { url = new URL(req.url || '/', `http://${host}`); }
  catch { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end();
    }
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /seguimiento/\nDisallow: /pago/\nSitemap: ' + publicBaseUrl(req) + '/sitemap.xml\n');
    }
    if (url.pathname === '/sitemap.xml') {
      const base = escapeHtml(publicBaseUrl(req));
      const products = (await db.prepare('SELECT slug, updated_at FROM products WHERE active = 1 AND visible_in_store = 1 ORDER BY slug').all());
      const pages = ['/', '/quienes-somos', '/catalogo', '/presupuestos-mayoristas', '/carrito', '/contacto'];
      const urls = [...pages.map(path => `<url><loc>${base}${path === '/' ? '/' : path}</loc></url>`), ...products.map(product =>
        `<url><loc>${base}/productos/${encodeURIComponent(product.slug)}</loc><lastmod>${product.updated_at.slice(0, 10)}</lastmod></url>`),
      ];
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
    }
    if (['/', '/index.html', '/quienes-somos', '/catalogo', '/presupuestos-mayoristas', '/carrito', '/contacto'].includes(url.pathname) || /^\/(productos|seguimiento|pago)(\/|$)/.test(url.pathname)) {
      return await serveIndex(req, res, url.pathname);
    }
    return staticFile(res, url.pathname);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('Error de servidor:', status, url.pathname);
    return json(res, status, {
      error: error.code === 'ASSET_STORAGE_UNAVAILABLE' ? error.message : status >= 500 ? 'Ocurrio un problema. El registro guardado no se perdio; intenta de nuevo.' : error.message,
      code: error.code || 'INTERNAL_ERROR',
    });
  }
}

export default async function vercelHandler(req, res) {
  const protocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const requestUrl = new URL(req.url || '/', `${protocol}://${req.headers.host || 'localhost'}`);
  const urlPaths = requestUrl.searchParams.getAll('__path');
  const platformPaths = req.query?.__path;
  const platformPathList = Array.isArray(platformPaths) ? platformPaths : [platformPaths];
  const requestedPath = [...urlPaths].reverse().find(isInternalRequestPath)
    || [...platformPathList].reverse().find(isInternalRequestPath);

  if (requestedPath) {
    requestUrl.searchParams.delete('__path');
    req.url = `${requestedPath}${requestUrl.search}`;
  }

  return handleRequest(req, res);
}

function isInternalRequestPath(value) {
  return typeof value === 'string'
    && value.startsWith('/')
    && !value.startsWith('//')
    && !/[\\?#\u0000-\u001f]/.test(value);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const server = createServer(handleRequest);
  const bindHost = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
  server.listen(PORT, bindHost, () => {
    console.log(`DAYBREAKER está disponible en http://localhost:${PORT}`);
    if (!process.env.ADMIN_PASSWORD) console.log('Panel sin habilitar: configurá ADMIN_PASSWORD en .env.');
  });
  function shutdown() {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
