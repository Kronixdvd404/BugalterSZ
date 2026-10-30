import { handle } from '../../src/app.js';
import { withDatabase } from '../../src/db.js';

// Все запросы /api/* обрабатывает один обработчик (маршруты описаны в src/app.js).
// База: Cloudflare D1 (binding DB) или Turso, если заданы TURSO_DATABASE_URL и TURSO_AUTH_TOKEN.
export const onRequest = async ({ request, env }) => handle(request, await withDatabase(env));
