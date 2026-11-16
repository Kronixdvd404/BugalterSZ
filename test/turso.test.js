/* Адаптер Turso: те же сценарии сайта, но поверх libSQL (локальный файл вместо облака). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { wrapLibsql } from '../src/turso.js';
import { handle, backgroundTick } from '../src/app.js';

test('turso: регистрация, сканер и лента через адаптер libSQL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsz-turso-'));
  const client = createClient({ url: 'file:' + path.join(dir, 't.db') });
  await client.executeMultiple(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const env = { DB: wrapLibsql(client), DEMO: '1', HIBP_OFF: '1', BACKGROUND_SCAN: '0' };
  try {
    const call = (p, init = {}) =>
      handle(new Request('http://localhost' + p, { ...init, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...(init.headers || {}) } }), env);

    const reg = await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ nick: 'tester', password: 'correct-horse-1' }) });
    assert.equal(reg.status, 201);
    const cookie = reg.headers.getSetCookie()[0].split(';')[0];

    const me = await call('/api/auth/me', { headers: { cookie } });
    assert.equal(me.status, 200);

    for (let i = 0; i < 6; i++) {
      await backgroundTick(env);
      await client.execute("UPDATE meta SET v = '0' WHERE k = 'lease'"); // как в других тестах: не ждём паузу между шагами
    }
    const st = await (await call('/api/auction/status', { headers: { cookie } })).json();
    assert.ok(st.scanned > 0, 'сканер ничего не просканировал');
    const feed = await call('/api/auction/feed?region=ru', { headers: { cookie } });
    assert.equal(feed.status, 200);

    const add = await call('/api/ledger/entries', { method: 'POST', headers: { cookie }, body: JSON.stringify({ type: 'income', amount: '1000', note: 'тест' }) });
    assert.equal(add.status, 201);
    const list = await (await call('/api/ledger', { headers: { cookie } })).json();
    assert.equal(list.count, 1);
  } finally {
    client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
