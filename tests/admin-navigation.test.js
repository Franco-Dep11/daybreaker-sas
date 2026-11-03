import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

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
