/* Чёрный список, названия модулей, аккаунт и дни бухгалтерии (UTC+3). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDatabase } from '../server/db.js';
import { handle, dayStartOf } from '../src/app.js';
import { makeBlacklist } from '../src/blacklist.js';
import { moduleName, isModuleItem } from '../src/modules.js';
import { buildBaseline, makeIndex, evaluate } from '../src/deals.js';

const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const env = { DB: openDatabase(':memory:', schema), DEMO: '1', BACKGROUND_SCAN: '0' };
let cookie = '';
async function call(method, path, body) {
  const res = await handle(new Request('http://x.test' + path, { method, headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9', cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const sc = res.headers.getSetCookie()[0];
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json() };
}

test('чёрный список: категории, исключения, id и переменные окружения', () => {
  const bl = makeBlacklist({});
  assert.equal(bl({ id: 'a', name: 'Гипс', category: 'misc' }), true);
  assert.equal(bl({ id: 'a', name: 'Борщ', category: 'supply/food' }), true);
  assert.equal(bl({ id: 'a', name: 'Камуфляж', category: 'other/armor_motif' }), true);
  assert.equal(bl({ id: 'a', name: 'Скин', category: 'other/skins' }), false); // исключение
  assert.equal(bl({ id: 'a', name: 'АК', category: 'weapon/assault_rifle' }), false);
  assert.equal(bl({ id: 'a', name: 'Душа', category: '' }), false);
  assert.equal(makeBlacklist({ BLACKLIST_IDS: 'x1' })({ id: 'x1', name: 'Что-то', category: 'bullet' }), true);
  assert.equal(makeBlacklist({ BLACKLIST_OFF: '1' })({ id: 'a', name: 'Гипс', category: 'misc' }), false);
});

test('модули: название берётся из текста в кавычках', () => {
  assert.equal(moduleName({ qlt: 3, wpn_mod: 'Оружейный модуль «Снайпер»' }), 'Снайпер');
  assert.equal(moduleName({ info: { lines: { ru: '«Пробойник»' } } }), 'Пробойник');
  assert.equal(moduleName({ module_name: 'Слайдер' }), 'Слайдер');
  assert.equal(moduleName({ qlt: 2, ptn: 5 }), null);
  assert.equal(isModuleItem({ id: 'm', category: 'weapon_modules/weapon_module' }), true);
  assert.equal(isModuleItem({ id: 'm', category: 'misc' }), false);
});

test('модули: цена сравнивается внутри одного названия, затем по качеству', () => {
  const t = Date.now();
  const sales = [];
  for (let i = 0; i < 12; i++) {
    sales.push({ amount: 1, price: 100000 + i * 10, time: t - i * 1000, qlt: 2, ptn: null, mod: 'Снайпер' });
    sales.push({ amount: 1, price: 20000 + i * 10, time: t - i * 1000, qlt: 2, ptn: null, mod: 'Слайдер' });
  }
  const base = buildBaseline(sales, [], { now: t, forcedMode: 'unit' });
  const idx = makeIndex(base, { minSamples: 5, ptnWindow: 2 });
  assert.equal(idx.hasMod, true);
  const cheapSniper = evaluate(idx, { buyoutPrice: 60000, amount: 1, qlt: 2, ptn: null, mod: 'Снайпер' });
  assert.ok(cheapSniper.discount > 0.35, 'дешёвый «Снайпер» выгоден относительно других «Снайперов»');
  const normalSlider = evaluate(idx, { buyoutPrice: 20050, amount: 1, qlt: 2, ptn: null, mod: 'Слайдер' });
  assert.ok(Math.abs(normalSlider.discount) < 0.05, '«Слайдер» не сравнивается со «Снайпером»');
  assert.equal(evaluate(idx, { buyoutPrice: 1000, amount: 1, qlt: 2, ptn: null, mod: null }), null);
  assert.equal(evaluate(idx, { buyoutPrice: 1000, amount: 1, qlt: 2, ptn: null, mod: 'Ураган' }), null);
  const order = idx.summary().map((g) => g[4]);
  assert.deepEqual(order, ['Слайдер', 'Снайпер']); // по названию
});

test('страница модуля в демо: названия модулей и порядок', async () => {
  await call('POST', '/api/auth/register', { nick: 'feat', password: 'secret-123' });
  const d = (await call('GET', '/api/auction/item/d_wpn_module?region=ru')).data;
  assert.equal(d.isModule, true);
  assert.ok(d.mods.length >= 2, JSON.stringify(d.mods));
  assert.ok(d.groups.every((g) => g[4]));
  const names = d.groups.map((g) => g[4]);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'ru')));
  assert.ok(d.lots.every((l) => l.mod));
});

test('чёрный список: предметы скрыты из ленты, но находятся поиском и открываются', async () => {
  const s = (await call('GET', '/api/auction/search?q=Металлолом')).data.items;
  assert.equal(s[0].id, 'd_scrap');
  assert.equal((await call('GET', '/api/auction/item/d_scrap?region=ru')).status, 200);
  for (let i = 0; i < 30; i++) {
    await env.DB.prepare("UPDATE meta SET v = '0' WHERE k = 'lease'").run();
    await call('POST', '/api/auction/tick');
  }
  const feed = (await call('GET', '/api/auction/feed?limit=100')).data.items;
  assert.ok(feed.length > 0);
  for (const hidden of ['d_scrap', 'd_food', 'd_vodka', 'd_poster']) assert.ok(!feed.some((e) => e.itemId === hidden), hidden + ' не должен быть в ленте');
});

test('личный чёрный список и страница аккаунта', async () => {
  assert.equal((await call('PUT', '/api/hidden/d_ak74', {})).status, 200);
  let h = (await call('GET', '/api/hidden')).data.items;
  assert.deepEqual(h.map((i) => i.id), ['d_ak74']);
  assert.equal((await call('PUT', '/api/hidden/nope', {})).status, 404);
  assert.equal((await call('DELETE', '/api/hidden/d_ak74')).status, 200);
  h = (await call('GET', '/api/hidden')).data.items;
  assert.equal(h.length, 0);

  const a = (await call('GET', '/api/account')).data;
  assert.equal(a.nick, 'feat');
  assert.ok(a.lastLogin > 0 && a.createdAt > 0);
  const before = a.lastLogin;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call('POST', '/api/auth/login', { nick: 'feat', password: 'secret-123' })).status, 200);
  const b = (await call('GET', '/api/account')).data;
  assert.ok(b.lastLogin > before);
  assert.equal(b.prevLogin, before);
});

test('бухгалтер: сегодня только текущий день по UTC+3, прошлые дни в архиве', async () => {
  const me = await env.DB.prepare("SELECT id FROM users WHERE nick = 'feat'").first();
  const now = Date.now();
  const today = dayStartOf(now);
  assert.equal(today % 3600000, 0);
  assert.equal(new Date(today + 3 * 3600000).getUTCHours(), 0); // начало дня — 00:00 по UTC+3
  const ins = (id, type, amount, ts) => env.DB.prepare('INSERT INTO ledger (id, uid, type, amount, note, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(id, me.id, type, amount, id, ts).run();
  await ins('old1', 'income', 5000, today - 3600_000); // вчера, за час до полуночи
  await ins('old2', 'expense', 1000, today - 5 * 3600_000);
  await ins('old3', 'income', 700, today - 86400_000 - 3600_000); // позавчера
  await call('POST', '/api/ledger/entries', { type: 'income', amount: '1к', note: 'сегодня' });

  const l = (await call('GET', '/api/ledger')).data;
  assert.equal(l.entries.length, 1);
  assert.equal(l.entries[0].note, 'сегодня');
  assert.equal(l.day.income, 1000);
  assert.equal(l.balance, 5000 - 1000 + 700 + 1000); // баланс считается по всей истории
  assert.equal(l.day.from, today);

  const s = (await call('GET', '/api/ledger/summary')).data;
  assert.equal(s.from, today);
  assert.equal(s.earned, 1000);
  assert.equal(s.spent, 0);

  const arch = (await call('GET', '/api/ledger/archive')).data;
  assert.equal(arch.days.length, 2);
  assert.equal(arch.days[0].day, today - 86400_000);
  assert.equal(arch.days[0].net, 4000);
  assert.equal(arch.days[0].count, 2);
  assert.equal(arch.days[1].net, 700);
  assert.equal(arch.days[0].balanceEnd, 700 + 4000);

  const day = (await call('GET', '/api/ledger/archive/' + arch.days[0].day)).data;
  assert.equal(day.entries.length, 2);
  assert.equal(day.earned, 5000);

  const del = await call('DELETE', '/api/ledger/entries/old1');
  assert.equal(del.status, 403); // из архива удалять нельзя
});
