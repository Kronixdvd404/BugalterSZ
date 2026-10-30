import { wrapLibsql } from './turso.js';

let turso = null;

/**
 * Если заданы TURSO_DATABASE_URL и TURSO_AUTH_TOKEN, базой становится Turso, иначе остаётся D1 (env.DB).
 * Так сайт работает и с Cloudflare D1, и с Turso без изменения остального кода.
 */
export async function withDatabase(env) {
  if (!env.TURSO_DATABASE_URL) return env;
  if (!turso) {
    const { createClient } = await import('@libsql/client/web');
    // В Workers надёжнее https-адрес, чем libsql://
    const url = String(env.TURSO_DATABASE_URL).replace(/^libsql:\/\//, 'https://');
    turso = wrapLibsql(createClient({ url, authToken: env.TURSO_AUTH_TOKEN }));
  }
  return { ...env, DB: turso };
}
