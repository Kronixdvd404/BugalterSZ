/* Резервная копия базы: `npm run backup`. Копии лежат в data/backups, хранятся последние 14. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (_) {}
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const src = path.join(dataDir, 'bugalter.db');
if (!fs.existsSync(src)) {
  console.error('Базы нет: ' + src);
  process.exit(1);
}
const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const dest = path.join(dir, `bugalter-${stamp}.db`);
if (fs.existsSync(dest)) fs.rmSync(dest);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
const files = fs.readdirSync(dir).filter((f) => /^bugalter-.*\.db$/.test(f)).sort();
for (const f of files.slice(0, -14)) fs.rmSync(path.join(dir, f));
console.log('Копия сохранена: ' + dest);
