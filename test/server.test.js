/* Проверка собственного сервера: сайт, регистрация, фоновый сканер в демо-режиме, база в файле. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('server: сайт, API и фоновый сканер', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsz-'));
  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, DEMO: '1', EXBO_CLIENT_ID: '', EXBO_CLIENT_SECRET: '' },
    stdio: 'ignore'
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try {
        up = (await fetch(base + '/healthz')).ok;
      } catch (_) {
        await sleep(100);
      }
    }
    assert.ok(up, 'сервер не поднялся');

    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    assert.ok(page.headers.get('content-security-policy'), 'нет заголовка CSP');
    assert.equal((await fetch(base + '/_headers')).status, 404);
    assert.equal((await fetch(base + '/..%2f..%2fetc/passwd')).status, 404);

    const reg = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: 'tester', password: 'correct-horse-1' })
    });
    assert.equal(reg.status, 201);
    const cookie = reg.headers.getSetCookie()[0].split(';')[0];

    const tick = await fetch(base + '/api/auction/tick', { method: 'POST', headers: { cookie } });
    assert.equal((await tick.json()).background, true, 'вкладка не должна запускать сканер');

    let scanned = 0;
    for (let i = 0; i < 40 && !scanned; i++) {
      await sleep(250);
      const st = await (await fetch(base + '/api/auction/status', { headers: { cookie } })).json();
      scanned = st.scanned || 0;
    }
    assert.ok(scanned > 0, 'фоновый сканер ничего не просканировал');
    assert.ok(fs.existsSync(path.join(dir, 'bugalter.db')), 'файл базы не создан');
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
