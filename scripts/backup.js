import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, databasePath } from '../src/db.js';

const backupDir = resolve(process.cwd(), 'backups');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(backupDir, `daybreaker-${stamp}.sqlite`);
const escapedPath = output.replace(/'/g, "''");
try {
  db.exec(`VACUUM INTO '${escapedPath}'`);
  console.log(`Copia creada: ${output}`);
  console.log(`Base activa: ${databasePath}`);
} finally {
  db.close();
}
