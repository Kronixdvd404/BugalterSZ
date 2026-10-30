/*
 * Адаптер: база Turso (libSQL, та же SQLite) с интерфейсом Cloudflare D1.
 * Код сайта (src/app.js, src/scanner.js) пишет prepare/bind/run/all/first/batch и не знает, какая база под ним.
 */
const clean = (a) => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a);
const toRows = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));

export function wrapLibsql(client) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    _def: { sql, args: args.map(clean) },
    async run() {
      const r = await client.execute(this._def);
      return { results: [], meta: { changes: Number(r.rowsAffected) } };
    },
    async all() {
      const r = await client.execute(this._def);
      return { results: toRows(r), meta: { changes: Number(r.rowsAffected) } };
    },
    async first() {
      const r = await client.execute(this._def);
      return r.rows.length ? toRows(r)[0] : null;
    }
  });
  return {
    prepare: (sql) => stmt(sql),
    // Один запрос к Turso на всю пачку, выполняется в одной транзакции (как D1 batch).
    async batch(list) {
      const rs = await client.batch(list.map((s) => s._def), 'write');
      return rs.map((r) => ({ results: toRows(r), meta: { changes: Number(r.rowsAffected) } }));
    }
  };
}
