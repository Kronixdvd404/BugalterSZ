/* Безопасность регистрации и входа: политика паролей, перец, блокировки, сессии, удаление аккаунта. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../src/app.js';
import { hashPassword, verifyPassword, needsRehash } from '../src/auth.js';
import { passwordProblem } from '../src/passwords.js';
import { nickSkeleton, isReservedNick } from '../src/nick.js';
import { isPwned } from '../src/hibp.js';

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

const DB = createD1();
const baseEnv = { DB, DEMO: '1', HIBP_OFF: '1', PBKDF2_ITER: '10000', REG_PER_HOUR: '50' };

async function call(env, method, path, body, { cookie = '', ip = '10.0.0.1', base = 'http://x.test', headers = {} } = {}) {
  const res = await handle(new Request(base + path, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]);
  return { status: res.status, data: await res.json(), cookie: cookies[0] || '', raw: res.headers.getSetCookie() };
}
const GOOD = 'correct-horse-9';

test('политика паролей', () => {
  assert.equal(passwordProblem('short1', 'bob'), 'Пароль должен быть не короче 10 символов');
  assert.equal(passwordProblem('x'.repeat(129), 'bob'), 'Пароль слишком длинный');
  assert.equal(passwordProblem('qwertyuiop', 'bob'), 'Пароль слишком простой, придумайте другой');
  assert.equal(passwordProblem('Password12345', 'bob'), 'Пароль слишком простой, придумайте другой'); // основа + цифры
  assert.equal(passwordProblem('aaaaaaaaaaaa', 'bob'), 'Пароль слишком простой, придумайте другой');
  assert.equal(passwordProblem('my-Stalker-pass-1', 'stalker'), 'Пароль не должен содержать ваш ник');
  assert.equal(passwordProblem('correct horse battery', 'bob'), null); // длинная фраза без цифр и символов подходит
  assert.equal(passwordProblem('correct-horse-9', 'bob'), null);
});

test('ники: «двойники» и служебные имена', () => {
  assert.equal(nickSkeleton('Kronix404'), nickSkeleton('Кronix404')); // русская К
  assert.equal(nickSkeleton('Kronix404'), nickSkeleton('kron_ix.404'));
  assert.equal(nickSkeleton('Stalker_77'), nickSkeleton('stalker77'));
  assert.notEqual(nickSkeleton('Stalker77'), nickSkeleton('Stalker78'));
  assert.ok(isReservedNick('Admin') && isReservedNick('Аdmin') && isReservedNick('Sup_port') && isReservedNick('BugalterSZ'));
  assert.ok(!isReservedNick('Maxim'));
});

test('хеш пароля: перец, старые хеши и пересчёт', async () => {
  const legacy = await hashPassword(GOOD, 10000);
  const peppered = await hashPassword(GOOD, 10000, 'secret-pepper');
  assert.ok(legacy.startsWith('pbkdf2$') && peppered.startsWith('pbkdf2p1$'));
  assert.ok(await verifyPassword(GOOD, legacy, 'secret-pepper')); // старый хеш работает и при заданном перце
  assert.ok(await verifyPassword(GOOD, peppered, 'secret-pepper'));
  assert.ok(!(await verifyPassword(GOOD, peppered, 'other-pepper')));
  assert.ok(!(await verifyPassword(GOOD, peppered, ''))); // перец потерян: проверить нечем
  assert.ok(!(await verifyPassword('wrong-password', peppered, 'secret-pepper')));
  assert.equal(needsRehash(legacy, 10000, ''), false);
  assert.equal(needsRehash(legacy, 10000, 'secret-pepper'), true); // появился перец
  assert.equal(needsRehash(legacy, 20000, ''), true); // выросло число итераций
  assert.equal(needsRehash(peppered, 10000, 'secret-pepper'), false);
});

test('проверка по базе утечек: k-anonymity и отказоустойчивость', async () => {
  let url = '';
  const hit = async (u) => {
    url = u;
    return new Response('0000000000000000000000000000000000A:0\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\n');
  };
  assert.equal(await isPwned('password', { fetchFn: hit }), true);
  assert.equal(url, 'https://api.pwnedpasswords.com/range/5BAA6'); // уходит только префикс
  assert.equal(await isPwned('another-long-passphrase', { fetchFn: hit }), false);
  assert.equal(await isPwned('password', { fetchFn: async () => { throw new Error('offline'); } }), false); // сбой = пропускаем
  assert.equal(await isPwned('password', { fetchFn: async () => new Response('', { status: 503 }) }), false);
});

test('регистрация: пароль, ник, двойники, утечки', async () => {
  const r = (b, ip) => call(baseEnv, 'POST', '/api/auth/register', b, { ip });
  assert.equal((await r({ nick: 'Maxim', password: 'short' }, '10.1.0.1')).status, 400);
  assert.equal((await r({ nick: 'Maxim', password: 'Maxim-is-cool-1' }, '10.1.0.1')).status, 400); // ник в пароле
  assert.equal((await r({ nick: 'Admin', password: GOOD }, '10.1.0.1')).data.error, 'Этот ник недоступен');
  const ok = await r({ nick: 'Kronix404', password: GOOD }, '10.1.0.1');
  assert.equal(ok.status, 201);
  assert.equal((await r({ nick: 'Кronix404', password: GOOD }, '10.1.0.1')).status, 409); // русская К
  assert.equal((await r({ nick: 'kron_ix404', password: GOOD }, '10.1.0.1')).status, 409);
  // пароль из утечки (мок сети через глобальный fetch)
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:99\r\n');
  try {
    const hibpEnv = { ...baseEnv, HIBP_OFF: undefined };
    const x = await call(hibpEnv, 'POST', '/api/auth/register', { nick: 'Leaked', password: 'password-not-short' }, { ip: '10.1.0.2' });
    assert.equal(x.status, 201, 'суффикс не совпал, пароль не в утечках');
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode('leaked-secret-phrase')))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    globalThis.fetch = async () => new Response(sha.slice(5) + ':42\r\n');
    const y = await call(hibpEnv, 'POST', '/api/auth/register', { nick: 'Leaked2', password: 'leaked-secret-phrase' }, { ip: '10.1.0.2' });
    assert.equal(y.status, 400);
    assert.match(y.data.error, /утечек/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('лимит регистраций с одного IP', async () => {
  const env = { ...baseEnv, REG_PER_HOUR: '2' };
  const r = (n) => call(env, 'POST', '/api/auth/register', { nick: 'limit' + n, password: GOOD }, { ip: '10.2.0.1' });
  assert.equal((await r(1)).status, 201);
  assert.equal((await r(2)).status, 201);
  assert.equal((await r(3)).status, 429);
  assert.equal((await call(env, 'POST', '/api/auth/register', { nick: 'limit9', password: GOOD }, { ip: '10.2.0.2' })).status, 201); // другой IP
});

test('блокировка после неудачных входов, другой IP не страдает', async () => {
  await call(baseEnv, 'POST', '/api/auth/register', { nick: 'victim', password: GOOD }, { ip: '10.3.0.9' });
  const login = (pw, ip) => call(baseEnv, 'POST', '/api/auth/login', { nick: 'victim', password: pw }, { ip });
  for (let i = 0; i < 5; i++) assert.equal((await login('wrong-password-' + i, '10.3.0.1')).status, 401);
  const locked = await login(GOOD, '10.3.0.1');
  assert.equal(locked.status, 429); // даже верный пароль с этого IP временно не принимается
  assert.match(locked.data.error, /неудачных попыток/);
  assert.equal((await login(GOOD, '10.3.0.2')).status, 200); // владелец с другого адреса входит
});

test('вход обновляет хеш: с перцем, а без перца такой хеш уже не проверить', async () => {
  const noPepper = baseEnv;
  const withPepper = { ...baseEnv, PASSWORD_PEPPER: 'test-pepper-123' };
  await call(noPepper, 'POST', '/api/auth/register', { nick: 'upgrade', password: GOOD }, { ip: '10.4.0.1' });
  assert.ok((await DB.prepare("SELECT pass FROM users WHERE nick_lc = 'upgrade'").first()).pass.startsWith('pbkdf2$'));
  assert.equal((await call(withPepper, 'POST', '/api/auth/login', { nick: 'upgrade', password: GOOD }, { ip: '10.4.0.1' })).status, 200);
  assert.ok((await DB.prepare("SELECT pass FROM users WHERE nick_lc = 'upgrade'").first()).pass.startsWith('pbkdf2p1$'));
  assert.equal((await call(withPepper, 'POST', '/api/auth/login', { nick: 'upgrade', password: GOOD }, { ip: '10.4.0.1' })).status, 200);
  assert.equal((await call(noPepper, 'POST', '/api/auth/login', { nick: 'upgrade', password: GOOD }, { ip: '10.4.0.3' })).status, 401);
});

test('куки: по https имя __Host-, флаг Secure, старая кука стирается', async () => {
  const https = await call(baseEnv, 'POST', '/api/auth/register', { nick: 'cookies', password: GOOD }, { ip: '10.5.0.1', base: 'https://x.test' });
  assert.equal(https.status, 201);
  assert.ok(https.raw[0].startsWith('__Host-sz_sid=') && /; Secure/.test(https.raw[0]) && /HttpOnly/.test(https.raw[0]) && /Path=\//.test(https.raw[0]) && !/Domain=/.test(https.raw[0]));
  assert.ok(https.raw[1].startsWith('sz_sid=;') && /Max-Age=0/.test(https.raw[1]));
  assert.equal((await call(baseEnv, 'GET', '/api/notes', undefined, { cookie: https.cookie, base: 'https://x.test' })).status, 200);
  const http = await call(baseEnv, 'POST', '/api/auth/login', { nick: 'cookies', password: GOOD }, { ip: '10.5.0.1' });
  assert.ok(http.raw[0].startsWith('sz_sid=') && !/Secure/.test(http.raw[0])); // локально по http остаётся обычная кука
  assert.equal((await call(baseEnv, 'GET', '/api/notes', undefined, { cookie: http.cookie })).status, 200);
});

test('чужой сайт в браузере (Sec-Fetch-Site: cross-site) отклоняется', async () => {
  const r = await call(baseEnv, 'POST', '/api/auth/login', { nick: 'cookies', password: GOOD }, { ip: '10.5.0.9', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
});

test('смена пароля закрывает остальные сессии, неверный пароль даёт 403', async () => {
  const reg = await call(baseEnv, 'POST', '/api/auth/register', { nick: 'changer', password: GOOD }, { ip: '10.6.0.1' });
  const a = reg.cookie;
  const b = (await call(baseEnv, 'POST', '/api/auth/login', { nick: 'changer', password: GOOD }, { ip: '10.6.0.1' })).cookie;
  assert.equal((await call(baseEnv, 'GET', '/api/notes', undefined, { cookie: b })).status, 200);
  assert.equal((await call(baseEnv, 'POST', '/api/account/password', { current: 'nope-nope-nope', next: 'brand-new-pass-77' }, { cookie: a, ip: '10.6.0.1' })).status, 403);
  assert.equal((await call(baseEnv, 'POST', '/api/account/password', { current: GOOD, next: 'weak' }, { cookie: a, ip: '10.6.0.1' })).status, 400);
  assert.equal((await call(baseEnv, 'POST', '/api/account/password', { current: GOOD, next: GOOD }, { cookie: a, ip: '10.6.0.1' })).status, 400);
  assert.equal((await call(baseEnv, 'POST', '/api/account/password', { current: GOOD, next: 'brand-new-pass-77' }, { cookie: a, ip: '10.6.0.1' })).status, 200);
  assert.equal((await call(baseEnv, 'GET', '/api/notes', undefined, { cookie: a })).status, 200); // текущая сессия осталась
  assert.equal((await call(baseEnv, 'GET', '/api/notes', undefined, { cookie: b })).status, 401); // остальные закрыты
  assert.equal((await call(baseEnv, 'POST', '/api/auth/login', { nick: 'changer', password: GOOD }, { ip: '10.6.0.2' })).status, 401);
  assert.equal((await call(baseEnv, 'POST', '/api/auth/login', { nick: 'changer', password: 'brand-new-pass-77' }, { ip: '10.6.0.2' })).status, 200);
});

test('выход на всех устройствах и не больше 10 сессий на аккаунт', async () => {
  const reg = await call(baseEnv, 'POST', '/api/auth/register', { nick: 'multi', password: GOOD }, { ip: '10.7.0.1' });
  const cookies = [reg.cookie];
  for (let i = 0; i < 11; i++) cookies.push((await call(baseEnv, 'POST', '/api/auth/login', { nick: 'multi', password: GOOD }, { ip: '10.7.1.' + i })).cookie);
  const n = (await DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE uid = (SELECT id FROM users WHERE nick_lc = 'multi')").first()).n;
  assert.equal(n, 10);
  const last = cookies[cookies.length - 1];
  assert.equal((await call(baseEnv, 'POST', '/api/account/logout-all', {}, { cookie: last })).status, 200);
  assert.equal((await call(baseEnv, 'GET', '/api/notes', undefined, { cookie: last })).status, 401);
});

test('удаление аккаунта: пароль обязателен, данные стираются, ник освобождается', async () => {
  const reg = await call(baseEnv, 'POST', '/api/auth/register', { nick: 'goner', password: GOOD }, { ip: '10.8.0.1' });
  await call(baseEnv, 'POST', '/api/notes', { text: 'секрет' }, { cookie: reg.cookie });
  await call(baseEnv, 'POST', '/api/ledger/entries', { type: 'income', amount: '1к' }, { cookie: reg.cookie });
  assert.equal((await call(baseEnv, 'DELETE', '/api/account', { password: 'wrong-password' }, { cookie: reg.cookie, ip: '10.8.0.1' })).status, 403);
  assert.equal((await call(baseEnv, 'GET', '/api/notes', undefined, { cookie: reg.cookie })).status, 200); // неверный пароль не разлогинил
  const del = await call(baseEnv, 'DELETE', '/api/account', { password: GOOD }, { cookie: reg.cookie, ip: '10.8.0.1' });
  assert.equal(del.status, 200);
  const uid = (id) => DB.prepare('SELECT COUNT(*) AS n FROM ' + id + " WHERE uid NOT IN (SELECT id FROM users)").first();
  assert.equal((await uid('notes')).n, 0);
  assert.equal((await uid('ledger')).n, 0);
  assert.equal((await call(baseEnv, 'GET', '/api/notes', undefined, { cookie: reg.cookie })).status, 401);
  assert.equal((await call(baseEnv, 'POST', '/api/auth/login', { nick: 'goner', password: GOOD }, { ip: '10.8.0.2' })).status, 401);
  assert.equal((await call(baseEnv, 'POST', '/api/auth/register', { nick: 'goner', password: GOOD }, { ip: '10.8.0.3' })).status, 201); // ник свободен
});
