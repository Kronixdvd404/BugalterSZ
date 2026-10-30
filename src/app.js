import { getConfig } from './config.js';
import { HttpError, bad, json, newId } from './util.js';
import { NICK_RE, hashPassword, verifyPassword, startSession, endSession, userFromRequest, limitAuth } from './auth.js';
import { ExboApi } from './exbo.js';
import { DemoApi } from './demo.js';
import { loadCatalog, searchCatalog, tick, getFeed, getDeals, getStatus, itemDetail } from './scanner.js';
import Money from '../public/shared/money.js';

const { parseMoney } = Money;

/* ---------- маршрутизатор ---------- */

const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false });
};

const intParam = (v, d, min, max) => Math.min(max, Math.max(min, Number(v) || d));

/* ---------- бухгалтерия: хелперы ---------- */

async function totals(db, user) {
  const rows = (await db.prepare('SELECT type, COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM ledger WHERE uid = ?1 GROUP BY type').bind(user.id).all()).results || [];
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const r of rows) {
    count += r.c;
    if (r.type === 'income') income = r.s;
    else expense = r.s;
  }
  return { income, expense, balance: user.ledger_start + income - expense, count };
}

/* ---------- аккаунт ---------- */

route(
  'POST',
  '/api/auth/register',
  async ({ db, body, request, config, secure }) => {
    await limitAuth(db, request);
    const nick = String(body.nick || '').trim();
    const password = String(body.password || '');
    if (!NICK_RE.test(nick)) throw bad('Ник: 3–20 символов, буквы, цифры, _ . -');
    if (password.length < 6) throw bad('Пароль должен быть не короче 6 символов');
    if (password.length > 128) throw bad('Пароль слишком длинный');
    const exists = await db.prepare('SELECT 1 FROM users WHERE nick_lc = ?1').bind(nick.toLowerCase()).first();
    if (exists) throw bad('Этот ник уже занят', 409);

    const user = { id: newId(), nick, ledger_start: 0 };
    try {
      await db
        .prepare('INSERT INTO users (id, nick, nick_lc, pass, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(user.id, nick, nick.toLowerCase(), await hashPassword(password, config.pbkdf2Iter), Date.now())
        .run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw bad('Этот ник уже занят', 409);
      throw e;
    }
    const cookie = await startSession(db, user, secure);
    return json({ user: { nick } }, 201, { 'Set-Cookie': cookie });
  },
  { auth: false }
);

route(
  'POST',
  '/api/auth/login',
  async ({ db, body, request, config, secure }) => {
    await limitAuth(db, request);
    const nick = String(body.nick || '').trim();
    const password = String(body.password || '');
    const user = await db.prepare('SELECT id, nick, pass FROM users WHERE nick_lc = ?1').bind(nick.toLowerCase()).first();
    // Хеш считаем и для несуществующего ника, чтобы по времени ответа нельзя было угадать ники.
    const ok = user ? await verifyPassword(password, user.pass) : (await hashPassword(password, config.pbkdf2Iter), false);
    if (!user || !ok) throw bad('Неверный ник или пароль', 401);
    return json({ user: { nick: user.nick } }, 200, { 'Set-Cookie': await startSession(db, user, secure) });
  },
  { auth: false }
);

route('POST', '/api/auth/logout', async ({ db, request, secure }) => json({ ok: true }, 200, { 'Set-Cookie': await endSession(db, request, secure) }), { auth: false });

route('GET', '/api/auth/me', async ({ user }) => json({ user: user ? { nick: user.nick } : null }), { auth: false });

route('GET', '/api/config', async ({ config }) => json({ regions: config.regions, demo: config.demo }), { auth: false });

/* ---------- бухгалтерия ---------- */

route('GET', '/api/ledger', async ({ db, user, query }) => {
  const limit = intParam(query.limit, 200, 1, 500);
  const [t, rows] = await Promise.all([totals(db, user), db.prepare('SELECT id, type, amount, note, ts FROM ledger WHERE uid = ?1 ORDER BY ts DESC, rowid DESC LIMIT ?2').bind(user.id, limit).all()]);
  return json({ start: user.ledger_start, ...t, entries: rows.results || [] });
});

route('PUT', '/api/ledger/start', async ({ db, user, body }) => {
  const r = parseMoney(body.value);
  if (!r.ok) throw bad(r.error);
  await db.prepare('UPDATE users SET ledger_start = ?1 WHERE id = ?2').bind(r.value, user.id).run();
  const t = await totals(db, { ...user, ledger_start: r.value });
  return json({ start: r.value, ...t });
});

route('POST', '/api/ledger/entries', async ({ db, user, body }) => {
  const { type, amount, note } = body;
  if (type !== 'income' && type !== 'expense') throw bad('Тип операции: доход или расход');
  const r = parseMoney(amount);
  if (!r.ok) throw bad(r.error);
  if (r.value === 0) throw bad('Сумма должна быть больше нуля');
  const t0 = await totals(db, user);
  if (t0.count >= 20000) throw bad('Слишком много операций');
  const entry = { id: newId(), type, amount: r.value, note: String(note || '').trim().slice(0, 120), ts: Date.now() };
  await db.prepare('INSERT INTO ledger (id, uid, type, amount, note, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(entry.id, user.id, entry.type, entry.amount, entry.note, entry.ts).run();
  return json({ entry, ...(await totals(db, user)) }, 201);
});

route('DELETE', '/api/ledger/entries/:id', async ({ db, user, params }) => {
  const r = await db.prepare('DELETE FROM ledger WHERE id = ?1 AND uid = ?2').bind(params.id, user.id).run();
  if (!r.meta.changes) throw bad('Операция не найдена', 404);
  return json(await totals(db, user));
});

// Итог за день. Границы дня присылает браузер (его часовой пояс), в миллисекундах.
route('GET', '/api/ledger/summary', async ({ db, user, query }) => {
  const from = Number(query.from);
  const to = Number(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 48 * 3600 * 1000) throw bad('Неверный период');
  const [before, inside, topIn, topOut] = await db.batch([
    db.prepare("SELECT COALESCE(SUM(CASE type WHEN 'income' THEN amount ELSE -amount END), 0) AS s FROM ledger WHERE uid = ?1 AND ts < ?2").bind(user.id, from),
    db.prepare('SELECT type, COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM ledger WHERE uid = ?1 AND ts >= ?2 AND ts < ?3 GROUP BY type').bind(user.id, from, to),
    db.prepare("SELECT id, type, amount, note, ts FROM ledger WHERE uid = ?1 AND type = 'income' AND ts >= ?2 AND ts < ?3 ORDER BY amount DESC LIMIT 1").bind(user.id, from, to),
    db.prepare("SELECT id, type, amount, note, ts FROM ledger WHERE uid = ?1 AND type = 'expense' AND ts >= ?2 AND ts < ?3 ORDER BY amount DESC LIMIT 1").bind(user.id, from, to)
  ]);
  let earned = 0;
  let spent = 0;
  let incomeCount = 0;
  let expenseCount = 0;
  for (const r of inside.results || []) {
    if (r.type === 'income') {
      earned = r.s;
      incomeCount = r.c;
    } else {
      spent = r.s;
      expenseCount = r.c;
    }
  }
  const balanceStart = user.ledger_start + (before.results[0].s || 0);
  const net = earned - spent;
  return json({
    from,
    to,
    earned,
    spent,
    net,
    balanceStart,
    balanceEnd: balanceStart + net,
    incomeCount,
    expenseCount,
    topIncome: (topIn.results || [])[0] || null,
    topExpense: (topOut.results || [])[0] || null,
    verdict: net > 0 ? 'plus' : net < 0 ? 'minus' : 'zero'
  });
});

/* ---------- заметки ---------- */

const NOTE_MAX = 20000;
const noteOut = (n) => ({ id: n.id, text: n.text, createdAt: n.created_at, updatedAt: n.updated_at });

route('GET', '/api/notes', async ({ db, user }) => {
  const rows = (await db.prepare('SELECT id, substr(text, 1, 400) AS text, created_at, updated_at FROM notes WHERE uid = ?1 ORDER BY updated_at DESC').bind(user.id).all()).results || [];
  return json({ notes: rows.map(noteOut) });
});

route('GET', '/api/notes/:id', async ({ db, user, params }) => {
  const n = await db.prepare('SELECT id, text, created_at, updated_at FROM notes WHERE id = ?1 AND uid = ?2').bind(params.id, user.id).first();
  if (!n) throw bad('Заметка не найдена', 404);
  return json({ note: noteOut(n) });
});

route('POST', '/api/notes', async ({ db, user, body }) => {
  const c = await db.prepare('SELECT COUNT(*) AS n FROM notes WHERE uid = ?1').bind(user.id).first();
  if (c.n >= 500) throw bad('Слишком много заметок, удалите ненужные');
  const now = Date.now();
  const note = { id: newId(), text: String(body.text || '').slice(0, NOTE_MAX), created_at: now, updated_at: now };
  await db.prepare('INSERT INTO notes (id, uid, text, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(note.id, user.id, note.text, now, now).run();
  return json({ note: noteOut(note) }, 201);
});

route('PUT', '/api/notes/:id', async ({ db, user, params, body }) => {
  const n = await db.prepare('SELECT id, text, created_at, updated_at FROM notes WHERE id = ?1 AND uid = ?2').bind(params.id, user.id).first();
  if (!n) throw bad('Заметка не найдена', 404);
  const text = String(body.text || '').slice(0, NOTE_MAX);
  if (text !== n.text) {
    n.text = text;
    n.updated_at = Date.now();
    await db.prepare('UPDATE notes SET text = ?1, updated_at = ?2 WHERE id = ?3 AND uid = ?4').bind(text, n.updated_at, n.id, user.id).run();
  }
  return json({ note: noteOut(n) });
});

route('DELETE', '/api/notes/:id', async ({ db, user, params }) => {
  const r = await db.prepare('DELETE FROM notes WHERE id = ?1 AND uid = ?2').bind(params.id, user.id).run();
  if (!r.meta.changes) throw bad('Заметка не найдена', 404);
  return json({ ok: true });
});

/* ---------- аукцион ---------- */

// Лента, выгодные лоты и статус одинаковы для всех пользователей, поэтому короткий кэш в памяти
// сильно режет число чтений D1 (каждая открытая вкладка опрашивает эти адреса постоянно).
const ttlCache = new Map();
async function cached(key, ttlMs, make) {
  const now = Date.now();
  const hit = ttlCache.get(key);
  if (hit && hit.exp > now) return hit.data;
  const data = await make();
  if (ttlCache.size > 200) ttlCache.clear();
  ttlCache.set(key, { exp: now + ttlMs, data });
  return data;
}

const regionParam = (config, v) => (config.regions.includes(String(v)) ? String(v) : 'all');
const makeApi = (config, db) => (config.demo ? new DemoApi() : new ExboApi(config, db));

async function catalogOf(ctx) {
  try {
    return await loadCatalog({ env: ctx.env, request: ctx.request, config: ctx.config, demoApi: new DemoApi() });
  } catch (e) {
    throw bad(e.message, 503);
  }
}

route('GET', '/api/auction/status', async (ctx) => json(await cached('status', 12000, async () => getStatus(ctx.db, { config: ctx.config, catalog: await catalogOf(ctx) }))));

route('GET', '/api/auction/feed', async ({ db, config, query }) => {
  const region = regionParam(config, query.region);
  const after = Number(query.after) || 0;
  const limit = intParam(query.limit, 40, 1, 100);
  return json(await cached(`feed:${region}:${after}:${limit}`, 4000, () => getFeed(db, { region, after, limit })));
});

route('GET', '/api/auction/deals', async ({ db, config, query }) => {
  const region = regionParam(config, query.region);
  const limit = intParam(query.limit, 6, 1, 12);
  return json({ items: await cached(`deals:${region}:${limit}`, 15000, () => getDeals(db, { region, limit })) });
});

route('GET', '/api/auction/search', async (ctx) => json({ items: searchCatalog(await catalogOf(ctx), ctx.query.q, 12) }));

route('GET', '/api/auction/item/:id', async (ctx) => {
  const { db, config, query, params } = ctx;
  const region = config.regions.includes(query.region) ? query.region : config.regions[0];
  const catalog = await catalogOf(ctx);
  let data;
  try {
    data = await itemDetail({ db, api: makeApi(config, db), config, catalog, region, id: params.id });
  } catch (e) {
    throw bad('Не удалось получить данные аукциона: ' + e.message, 502);
  }
  if (!data) throw bad('Предмет не найден', 404);
  return json(data);
});

// Один шаг сканера. Вызывается открытой страницей; можно дёргать и по расписанию (заголовок X-Tick-Secret).
route(
  'POST',
  '/api/auction/tick',
  async (ctx) => {
    const { db, config, request, user } = ctx;
    const secret = request.headers.get('x-tick-secret');
    const byCron = Boolean(config.tickSecret) && secret === config.tickSecret;
    if (!user && !byCron) throw bad('Нужно войти', 401);
    if (config.backgroundScan) return json({ skipped: true, background: true }); // сканер работает на сервере сам
    const catalog = await catalogOf(ctx);
    return json(await tick({ db, api: makeApi(config, db), config, catalog }));
  },
  { auth: false }
);

/** Шаг сканера без HTTP-запроса: его вызывает фоновый цикл собственного сервера (server/index.js). */
export async function backgroundTick(env) {
  const config = getConfig(env);
  const ctx = { env, request: new Request('http://localhost/'), config };
  const catalog = await catalogOf(ctx);
  return tick({ db: env.DB, api: makeApi(config, env.DB), config, catalog });
}

/* ---------- вход ---------- */

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (!env.DB) throw new HttpError('Не подключена база данных D1 (binding с именем DB). См. README.', 500);

    const match = routes.find((r) => r.method === request.method && r.re.test(path));
    if (!match) {
      const known = routes.some((r) => r.re.test(path));
      throw new HttpError(known ? 'Метод не поддерживается' : 'Не найдено', known ? 405 : 404);
    }

    const mutating = request.method !== 'GET';
    let body = {};
    if (mutating) {
      // Защита от CSRF поверх SameSite: запрос должен прийти с этого же сайта и как JSON.
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) throw new HttpError('Запрещено', 403);
      const text = await request.text();
      if (text) {
        if (!String(request.headers.get('content-type') || '').includes('application/json')) throw new HttpError('Ожидается JSON', 415);
        try {
          body = JSON.parse(text) || {};
        } catch (_) {
          throw new HttpError('Некорректный JSON', 400);
        }
      }
    }

    const m = path.match(match.re);
    const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const config = getConfig(env);
    const user = await userFromRequest(env.DB, request);
    if (match.auth && !user) throw new HttpError('Нужно войти', 401);

    return await match.handler({
      request,
      env,
      db: env.DB,
      config,
      user,
      body,
      params,
      query: Object.fromEntries(url.searchParams),
      secure: url.protocol === 'https:'
    });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('[api]', e && e.stack ? e.stack : e);
    return json({ error: 'Внутренняя ошибка сервера' }, 500);
  }
}
