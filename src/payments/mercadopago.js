import { createHmac, timingSafeEqual } from 'node:crypto';
import { asAmount, badRequest } from '../domain.js';

function requirePaymentConfig() {
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN || !process.env.MERCADOPAGO_WEBHOOK_SECRET) {
    throw badRequest('Mercado Pago todavía no está configurado para la cuenta de DAYBREAKER.', 503, 'PAYMENT_NOT_CONFIGURED');
  }
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw badRequest('Falta configurar la URL pública segura para habilitar Mercado Pago.', 503, 'PAYMENT_NOT_CONFIGURED');
  const parsed = new URL(base);
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw badRequest('Mercado Pago requiere que PUBLIC_BASE_URL use HTTPS en producción.', 503, 'PAYMENT_NOT_CONFIGURED');
  }
  return { base: parsed.origin, token: process.env.MERCADOPAGO_ACCESS_TOKEN };
}

export async function createPreference(order, items) {
  const config = requirePaymentConfig();
  const base = config.base;
  const mpItems = items.map(item => ({
    id: item.product_slug,
    title: item.product_name,
    quantity: item.quantity,
    currency_id: 'ARS',
    unit_price: asAmount(item.unit_price_cents),
  }));
  mpItems.push({
    id: 'flete-cotizado',
    title: 'Flete cotizado',
    quantity: 1,
    currency_id: 'ARS',
    unit_price: asAmount(order.freight_cents),
  });

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: mpItems,
      payer: { name: order.customer_name, email: order.email },
      external_reference: order.id,
      back_urls: {
        success: `${base}/pago/resultado?estado=success&pedido=${encodeURIComponent(order.id)}`,
        pending: `${base}/pago/resultado?estado=pending&pedido=${encodeURIComponent(order.id)}`,
        failure: `${base}/pago/resultado?estado=failure&pedido=${encodeURIComponent(order.id)}`,
      },
      auto_return: 'approved',
      notification_url: `${base}/api/webhooks/mercadopago`,
      metadata: { order_id: order.id },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.id || !(result.init_point || result.sandbox_init_point)) {
    console.error('Mercado Pago no creó la preferencia:', response.status, result.message || result.error || 'respuesta no válida');
    throw badRequest('No se pudo iniciar el pago con Mercado Pago. El pedido sigue guardado; intentá más tarde o contactanos.', 502, 'PAYMENT_PROVIDER_ERROR');
  }
  return { id: String(result.id), url: result.init_point || result.sandbox_init_point };
}

export function validWebhookSignature({ signature, requestId, dataId, secret }) {
  if (!signature || !requestId || !dataId || !secret) return false;
  const fields = Object.fromEntries(signature.split(',').map(part => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  if (!fields.ts || !fields.v1 || !/^\d+$/.test(fields.ts) || !/^[a-f0-9]{64}$/i.test(fields.v1)) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${fields.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  const actual = Buffer.from(fields.v1, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function fetchPayment(paymentId) {
  const { token } = requirePaymentConfig();
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Mercado Pago respondió ${response.status} al consultar el pago.`);
  return response.json();
}
