/* Создаёт таблицы в Turso: `npm run db:turso` (нужны TURSO_DATABASE_URL и TURSO_AUTH_TOKEN в окружении или в файле .env). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { nickSkeleton } from '../src/nick.js';

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
// Скелеты уже существующих ников: по ним новые ники-«двойники» не пройдут регистрацию (безопасно запускать повторно).
const users = await client.execute('SELECT id, nick FROM users');
if (users.rows.length) {
  await client.batch(users.rows.map((r) => ({ sql: 'INSERT OR IGNORE INTO nick_skeleton (sk, uid) VALUES (?, ?)', args: [nickSkeleton(String(r[1])), String(r[0])] })), 'write');
  console.log('Скелеты ников обновлены: ' + users.rows.length);
}
const t = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
console.log('Готово. Таблицы: ' + t.rows.map((r) => r[0]).join(', '));
client.close();
