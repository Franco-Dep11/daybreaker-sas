const MAX_ARS_CENTS = 9_000_000_000_000;

export const ORDER_STATUSES = Object.freeze([
  'received',
  'freight_quoted',
  'awaiting_payment',
  'payment_confirmed',
  'preparing',
  'dispatched',
  'delivered',
  'canceled',
]);

export const QUOTE_STATUSES = Object.freeze(['pending', 'responded', 'closed']);
export const AVAILABILITY = Object.freeze(['available', 'sold_out', 'on_request']);

export function text(value, label, { required = true, max = 240 } = {}) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw badRequest(`${label}: este dato es obligatorio.`);
  if (result.length > max) throw badRequest(`${label}: supera el máximo de ${max} caracteres.`);
  return result;
}

export function email(value) {
  const result = text(value, 'Email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw badRequest('Ingresá un email válido.');
  return result;
}

export function parseMoneyCents(value, label = 'Importe') {
  if (typeof value !== 'string') throw badRequest(`${label}: ingresá un importe en pesos argentinos.`);
  const input = value.trim().replace(/\s/g, '');
  let normalized;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(input)) {
    normalized = input.replace(/\./g, '').replace(',', '.');
  } else if (/^\d+(,\d{1,2})?$/.test(input)) {
    normalized = input.replace(',', '.');
  } else {
    throw badRequest(`${label}: usá el formato 12.345,67.`);
  }
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_ARS_CENTS) {
    throw badRequest(`${label}: el importe debe ser mayor que cero y estar dentro del límite permitido.`);
  }
  return cents;
}

export function asAmount(cents) {
  return Number(cents) / 100;
}

export function slug(value) {
  return text(value, 'Nombre', { max: 120 })
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function quantity(value, label = 'Cantidad') {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 9999) {
    throw badRequest(`${label}: debe ser un número entero entre 1 y 9999.`);
  }
  return result;
}

export function badRequest(message, status = 400, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function makeSlug(input) {
  const result = slug(input);
  if (!result) throw badRequest('El nombre no permite generar una URL válida.');
  return result;
}
