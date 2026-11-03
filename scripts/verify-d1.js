import { db, verifyConnection } from '../src/db.js';

try {
  await verifyConnection();
  console.log('Cloudflare D1 respondió correctamente a la comprobación autenticada.');
} catch (error) {
  console.error(`No se pudo verificar Cloudflare D1: ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
