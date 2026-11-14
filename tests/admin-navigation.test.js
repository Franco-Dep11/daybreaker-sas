import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const luminance = hex => hex.match(/[a-f0-9]{2}/gi).map(value => parseInt(value, 16) / 255)
  .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (foreground, background) => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};

test('admin shell renders without waiting for administrative API data', () => {
  const page = section('function adminPage()', 'async function routePage()');
  assert.doesNotMatch(page, /\bapi\s*\(/);
  assert.match(page, /authStatus === 'unknown' \|\| state\.admin\.authStatus === 'checking'/);
  assert.match(source, /function renderAdminContent\(\)[\s\S]*?admin-data-loading/);
});

test('admin resources are loaded per tab and share in-flight requests', () => {
  const loader = section('function loadAdminResource(key)', 'function ensureAdminRouteData()');
  assert.match(loader, /if \(admin\.loaded\[key\]\)/);
  assert.match(loader, /if \(admin\.requests\[key\]\) return admin\.requests\[key\]/);
  assert.match(loader, /api\('\/api\/admin\/products'\)/);
  assert.match(loader, /api\('\/api\/admin\/categories'\)/);
  assert.match(loader, /api\('\/api\/admin\/orders'\)/);
  assert.match(loader, /api\('\/api\/admin\/quotes'\)/);
  assert.doesNotMatch(loader, /Promise\.all\(\[[^\]]*admin\/orders[^\]]*admin\/quotes/);
});

test('private admin data remains behind the server-validated session gate', () => {
  const gate = section('function ensureAdminRouteData()', 'function adminPage()');
  assert.match(gate, /api\('\/api\/admin\/session'\)/);
  assert.match(gate, /admin\.authStatus === 'authenticated'/);
  assert.match(source, /function clearAdminPrivateData\(\)[\s\S]*authStatus: 'unauthenticated'[\s\S]*orders: \[\][\s\S]*products: \[\]/);
  assert.match(source, /response\.status === 401[\s\S]*clearAdminPrivateData\(\)/);
});

test('admin login submits both the configured username and password', () => {
  assert.match(source, /name="username" type="text" autocomplete="username"/);
  assert.match(source, /body: \{ username: data\.get\('username'\), password: data\.get\('password'\) \}/);
});

test('visibility toggle uses the dedicated endpoint and login return button keeps contrast in every state', () => {
  const action = section("if (action === 'toggle-visibility')", "if (action === 'set-primary-image'");
  assert.match(action, /\/visibility`[^\n]*method: 'PATCH'/);
  assert.doesNotMatch(action, /retailPrice|method: 'PUT'/);
  assert.match(styles, /\.admin-shell \{ color: #172122; background: #f3f4f1; \}/);
  assert.match(styles, /\.admin-shell \.admin-login \.form-actions \.button-outline \{ color: #263331; background: #fff;/);
  assert.match(styles, /\.admin-shell \.admin-login \.form-actions \.button-outline:hover/);
  assert.match(styles, /\.admin-shell \.button-outline:focus-visible/);
  assert.match(styles, /\.admin-shell \.button:disabled/);
});

test('checkout uses a required alphabetized province selector with all Argentine jurisdictions', () => {
  assert.match(source, /function provinceSelect\(id, selected = ''\)/);
  assert.match(source, /<option value="" disabled[^>]*>Seleccioná una provincia<\/option>/);
  const provinceSource = source.match(/const argentineProvinces = \[([\s\S]*?)\];/)?.[1] || '';
  const provinces = [...provinceSource.matchAll(/'([^']+)'/g)].map(([, name]) => name);
  assert.equal(provinces.length, 24);
  assert.ok(provinces.includes('Ciudad Autónoma de Buenos Aires'));
  assert.deepEqual(provinces, [...provinces].sort((left, right) => left.localeCompare(right, 'es-AR')));
  assert.match(source, /Provincia<\/label>\$\{provinceSelect\('order-province'\)\}/);
});

test('admin palette keeps text contrast at WCAG AA for normal-size text', () => {
  const pairs = [
    ['172122', 'f3f4f1'], ['4b5653', 'ffffff'], ['172122', 'ff8059'],
    ['172122', 'ff9877'], ['8c351d', 'ffffff'], ['205b3f', 'e1f1e7'],
    ['46514c', 'e9eeea'], ['263331', 'ffffff'],
  ];
  for (const [foreground, background] of pairs) assert.ok(contrast(foreground, background) >= 4.5);
  assert.match(styles, /\.admin-shell \.button-outline:hover \{ color: #172122; background: #f0f2ef;/);
  assert.match(styles, /\.admin-shell \.button:disabled \{ color: #59635f; background: #edf0ed;/);
});
