/*
 * База данных для собственного сервера: файл SQLite (встроенный в Node модуль node:sqlite, ничего компилировать не нужно).
 * Обёртка повторяет интерфейс Cloudflare D1 (prepare/bind/run/all/first/batch), поэтому код из src/ работает без изменений.
 */
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(file, schemaSql) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  raw.exec(schemaSql); // схема написана с IF NOT EXISTS, повторный запуск безопасен

  const cache = new Map();
  const prepared = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      if (cache.size > 300) cache.clear();
      st = raw.prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
  const isRead = (sql) => /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql);

  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    _run() {
      const st = prepared(sql);
      if (isRead(sql)) return { results: st.all(...args), meta: { changes: 0 } };
      const r = st.run(...args);
      return { results: [], meta: { changes: Number(r.changes) } };
    },
    async run() {
      return this._run();
    },
    async all() {
      return this._run();
    },
    async first() {
      return this._run().results[0] || null;
    }
  });

  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      raw.exec('BEGIN');
      try {
        const out = list.map((s) => s._run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => raw.close(),
    raw
  };
}
