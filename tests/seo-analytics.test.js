import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const client = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const block = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('GA4 es optativo, no carga antes del consentimiento y se excluye de Preview', () => {
  const loader = block(client, 'function loadAnalyticsTag()', 'function analyticsEvent(');
  assert.match(loader, /if \(!measurementId \|\| !validAnalyticsConsent\(\)\) return/);
  assert.match(loader, /send_page_view: false/);
  assert.match(client, /function setupAnalyticsConsent\(\)[\s\S]*Aceptar analítica[\s\S]*Rechazar/);
  assert.match(client, /setAnalyticsConsent\(button\.dataset\.choice === 'granted' \? 'granted' : 'denied'\)/);
  assert.match(server, /analyticsMeasurementId: !isPreviewDeployment\(\)/);
  assert.match(server, /if \(deploymentNoindex\(\)\) res\.setHeader\('X-Robots-Tag', 'noindex, nofollow'\)/);
});

test('vistas SPA son manuales, sin consultas ni fragmentos y omiten páginas privadas', () => {
  const pageviews = block(client, 'function trackAnalyticsPage()', 'function trackConfirmedPurchase(');
  assert.match(pageviews, /pathname === lastAnalyticsPage/);
  assert.match(pageviews, /'event', 'page_view'/);
  assert.match(pageviews, /pathname\.startsWith\('\/seguimiento/);
  assert.match(pageviews, /pathname\.startsWith\('\/pago/);
  assert.match(pageviews, /page_location: pageLocation, page_path: pathname/);
  assert.doesNotMatch(pageviews, /window\.location\.href/);
  assert.match(client, /const pageLocation = `\$\{window\.location\.origin\}\$\{pathname\}`/);
});

test('eventos comerciales excluyen datos personales y purchase requiere pago confirmado', () => {
  const analytics = block(client, 'function analyticsEvent(', 'function setupAnalyticsConsent(');
  assert.match(analytics, /safePath = privatePath \? '\/' : pathname/);
  assert.match(client, /analyticsEvent\('view_item'/);
  assert.match(client, /analyticsEvent\('add_to_cart'/);
  assert.match(client, /analyticsEvent\('begin_checkout'/);
  assert.match(client, /analyticsEvent\('generate_lead'\)/);
  const purchase = block(client, 'function trackConfirmedPurchase(', 'function setupAnalyticsConsent(');
  assert.match(purchase, /order\.status !== 'payment_confirmed'/);
  assert.match(purchase, /transaction_id: order\.id/);
  assert.doesNotMatch(purchase, /customerName|email|phone|address|token/);
});
