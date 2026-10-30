/* Создаёт таблицы в Turso: `npm run db:turso` (нужны TURSO_DATABASE_URL и TURSO_AUTH_TOKEN в окружении или в файле .env). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (_) {}
const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) {
  console.error('Задай TURSO_DATABASE_URL и TURSO_AUTH_TOKEN (в окружении или в файле .env).');
  process.exit(1);
}
const client = createClient({ url, authToken });
await client.executeMultiple(fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));
const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
console.log('Готово. Таблицы: ' + t.rows.map((r) => r[0]).join(', '));
client.close();
