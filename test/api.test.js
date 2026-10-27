/*
 * Сквозная проверка API на демо-данных. Вместо Cloudflare D1 используется встроенная в Node SQLite
 * (node:sqlite) с тонкой обёрткой, повторяющей интерфейс D1 (prepare/bind/run/all/first/batch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/app.js';

function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    _run() {
      const s = db.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: s.all(...args), meta: { changes: 0 } };
      const r = s.run(...args);
      return { results: [], meta: { changes: Number(r.changes) } };
    },
    async run() { return this._run(); },
    async all() { return this._run(); },
    async first() { return this._run().results[0] || null; }
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => s._run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  };
}

const env = { DB: createD1(), DEMO: '1', PBKDF2_ITER: '10000', SCAN_BATCH: '40', FEED_BACKFILL_MIN: '120', DEAL_MIN_SAVINGS: '0' };
let cookie = '';

async function call(method, path, body) {
  const headers = { 'content-type': 'application/json', origin: 'https://x.test', cookie };
  const res = await handle(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, data: await res.json() };
}

test('регистрация, вход, выход', async () => {
  assert.equal((await call('GET', '/api/auction/status')).status, 401);
  const r = await call('POST', '/api/auth/register', { nick: 'Tester', password: 'secret1' });
  assert.equal(r.status, 201);
  assert.equal((await call('GET', '/api/auth/me')).data.user.nick, 'Tester');
  assert.equal((await call('POST', '/api/auth/register', { nick: 'tester', password: 'secret1' })).status, 409);
  await call('POST', '/api/auth/logout', {});
  cookie = '';
  assert.equal((await call('POST', '/api/auth/login', { nick: 'Tester', password: 'wrong!!' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { nick: 'tester', password: 'secret1' })).status, 200);
});

test('чужой Origin и не-JSON отклоняются', async () => {
  const res = await handle(new Request('https://x.test/api/ledger/start', { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://evil.test', cookie }, body: '{"value":"1к"}' }), env);
  assert.equal(res.status, 403);
  const res2 = await handle(new Request('https://x.test/api/notes', { method: 'POST', headers: { 'content-type': 'text/plain', cookie }, body: 'x' }), env);
  assert.equal(res2.status, 415);
});

test('бухгалтерия: баланс, итог дня, удаление', async () => {
  assert.equal((await call('PUT', '/api/ledger/start', { value: '10к' })).data.balance, 10000);
  const a = await call('POST', '/api/ledger/entries', { type: 'income', amount: '1.5кк', note: 'продажа' });
  assert.equal(a.status, 201);
  assert.equal(a.data.balance, 1_510_000);
  const b = await call('POST', '/api/ledger/entries', { type: 'expense', amount: '500к' });
  assert.equal(b.data.balance, 1_010_000);
  const l = await call('GET', '/api/ledger');
  assert.equal(l.data.entries.length, 2);
  assert.equal(l.data.entries[0].amount, 500000); // новые сверху
  const now = Date.now();
  const s = await call('GET', `/api/ledger/summary?from=${now - 3600_000}&to=${now + 3600_000}`);
  assert.equal(s.data.net, 1_000_000);
  assert.equal(s.data.balanceStart, 10000);
  assert.equal(s.data.verdict, 'plus');
  assert.equal(s.data.topIncome.note, 'продажа');
  const d = await call('DELETE', '/api/ledger/entries/' + b.data.entry.id);
  assert.equal(d.data.balance, 1_510_000);
  assert.equal((await call('DELETE', '/api/ledger/entries/nope')).status, 404);
});

test('заметки', async () => {
  const n = await call('POST', '/api/notes', { text: 'привет' });
  assert.equal(n.status, 201);
  await call('PUT', '/api/notes/' + n.data.note.id, { text: 'привет, мир' });
  assert.equal((await call('GET', '/api/notes/' + n.data.note.id)).data.note.text, 'привет, мир');
  assert.equal((await call('GET', '/api/notes')).data.notes.length, 1);
  assert.equal((await call('DELETE', '/api/notes/' + n.data.note.id)).status, 200);
  assert.equal((await call('GET', '/api/notes/' + n.data.note.id)).status, 404);
});

test('сканер: тики наполняют ленту и выгодные лоты с учётом качества и заточки', async () => {
  const first = await call('POST', '/api/auction/tick');
  assert.equal(first.status, 200);
  assert.ok(first.data.scanned > 0, JSON.stringify(first.data));
  // сразу повторный тик отсекается блокировкой (лимит запросов)
  assert.equal((await call('POST', '/api/auction/tick')).data.skipped, true);

  // прогоняем несколько тиков, сбрасывая блокировку
  for (let i = 0; i < 6; i++) {
    await env.DB.prepare("UPDATE meta SET v = '0' WHERE k = 'lease'").run();
    const t = await call('POST', '/api/auction/tick');
    assert.ok(t.data.ok, JSON.stringify(t.data));
  }
  const st = (await call('GET', '/api/auction/status')).data;
  assert.equal(st.mode, 'demo');
  assert.ok(st.feed > 0 && st.progress > 0, JSON.stringify(st));

  const feed = (await call('GET', '/api/auction/feed?limit=100')).data;
  assert.ok(feed.items.length > 0);
  assert.ok(feed.items.every((e) => e.seq > 0));

  const deals = (await call('GET', '/api/auction/deals?limit=12')).data.items;
  assert.ok(deals.length > 0, 'выгодные лоты должны находиться');
  for (const d of deals) {
    assert.ok(d.deal.discount >= 0.15 && d.deal.discount <= 0.9);
    if (d.qlt !== null) {
      // база сравнения — то же качество и та же (или меньшая) заточка
      assert.equal(d.deal.basis.qlt, d.qlt);
      assert.equal(d.deal.basis.ptn, d.ptn ?? 0);
      assert.ok(d.deal.basis.exact || d.deal.basis.ptnFrom < d.deal.basis.ptn);
    }
  }
  assert.ok(deals.some((d) => d.qlt !== null), 'среди выгодных есть артефакты');
});

test('страница предмета: медианы по качеству и заточке', async () => {
  const s = await call('GET', '/api/auction/search?q=' + encodeURIComponent('душа'));
  assert.equal(s.data.items[0].id, 'd_art_soul');
  const d = await call('GET', '/api/auction/item/d_art_soul?region=ru');
  assert.equal(d.status, 200);
  assert.equal(d.data.hasQuality, true);
  assert.ok(d.data.groups.length > 5);
  const [q, p, med] = d.data.groups.find((g) => g[0] === 5 && g[1] === 0) || d.data.groups[0];
  assert.ok(med > 0 && q !== null && p !== null);
  assert.ok(d.data.history.length > 10 && d.data.history[0].length === 4);
  // легендарная +0 заведомо дороже обычной +0
  const m = (qq, pp) => (d.data.groups.find((g) => g[0] === qq && g[1] === pp) || [])[2];
  if (m(0, 0) && m(5, 0)) assert.ok(m(5, 0) > m(0, 0) * 4);
});
