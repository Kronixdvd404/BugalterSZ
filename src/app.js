import { getConfig } from './config.js';
import { HttpError, bad, json, newId, timingSafeEqual } from './util.js';
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

// Операции делятся на дни по времени UTC+3: в 00:00 по UTC+3 начинается новый день, а прошлый уходит в архив.
const DAY_MS = 24 * 3600 * 1000;
const TZ_OFFSET = 3 * 3600 * 1000;
export const dayStartOf = (ts) => Math.floor((ts + TZ_OFFSET) / DAY_MS) * DAY_MS - TZ_OFFSET;

async function dayTotals(db, user, from, to) {
  const rows = (await db.prepare('SELECT type, COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM ledger WHERE uid = ?1 AND ts >= ?2 AND ts < ?3 GROUP BY type').bind(user.id, from, to).all()).results || [];
  const out = { earned: 0, spent: 0, incomeCount: 0, expenseCount: 0 };
  for (const r of rows) {
    if (r.type === 'income') {
      out.earned = r.s;
      out.incomeCount = r.c;
    } else {
      out.spent = r.s;
      out.expenseCount = r.c;
    }
  }
  out.net = out.earned - out.spent;
  return out;
}

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

/** Запоминает время входа. Если таблицы ещё нет (схему не обновили), вход всё равно работает. */
async function touchLogin(db, uid) {
  try {
    await db.prepare('INSERT INTO user_login (uid, last_login, prev_login) VALUES (?1, ?2, 0) ON CONFLICT(uid) DO UPDATE SET prev_login = last_login, last_login = ?2').bind(uid, Date.now()).run();
  } catch (e) {
    console.error('[login] не удалось сохранить время входа:', e && e.message);
  }
}

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
    await touchLogin(db, user.id);
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
    const cookie = await startSession(db, user, secure);
    await touchLogin(db, user.id);
    return json({ user: { nick: user.nick } }, 200, { 'Set-Cookie': cookie });
  },
  { auth: false }
);

route('POST', '/api/auth/logout', async ({ db, request, secure }) => json({ ok: true }, 200, { 'Set-Cookie': await endSession(db, request, secure) }), { auth: false });

route('GET', '/api/auth/me', async ({ user }) => json({ user: user ? { nick: user.nick } : null }), { auth: false });

route('GET', '/api/config', async ({ config }) => json({ regions: config.regions, demo: config.demo }), { auth: false });

route('GET', '/api/account', async ({ db, user }) => {
  const u = await db.prepare('SELECT created_at FROM users WHERE id = ?1').bind(user.id).first();
  let login = null;
  try {
    login = await db.prepare('SELECT last_login, prev_login FROM user_login WHERE uid = ?1').bind(user.id).first();
  } catch (_) {
    /* таблица появится после обновления схемы (npm run db:turso) */
  }
  if (!login) {
    // вошли до появления этой функции: считаем текущий сеанс последним входом
    await touchLogin(db, user.id);
    login = { last_login: Date.now(), prev_login: 0 };
  }
  return json({ nick: user.nick, createdAt: u ? u.created_at : null, lastLogin: login.last_login, prevLogin: login.prev_login || null });
});

/* ---------- личный чёрный список предметов ---------- */

const HIDDEN_MAX = 500;
const hiddenRows = async (db, user) => {
  try {
    return (await db.prepare('SELECT item_id FROM user_hidden WHERE uid = ?1 ORDER BY at DESC').bind(user.id).all()).results || [];
  } catch (_) {
    return []; // таблицы ещё нет
  }
};

route('GET', '/api/hidden', async (ctx) => {
  const catalog = await catalogOf(ctx);
  const rows = await hiddenRows(ctx.db, ctx.user);
  return json({
    items: rows.map((r) => {
      const it = catalog.byId.get(r.item_id);
      return { id: r.item_id, name: it ? it.name : r.item_id, icon: it ? it.icon : '' };
    })
  });
});

route('PUT', '/api/hidden/:id', async (ctx) => {
  const catalog = await catalogOf(ctx);
  const it = catalog.byId.get(ctx.params.id);
  if (!it) throw bad('Предмет не найден', 404);
  const rows = await hiddenRows(ctx.db, ctx.user);
  if (rows.length >= HIDDEN_MAX && !rows.some((r) => r.item_id === it.id)) throw bad('Слишком много скрытых предметов');
  await ctx.db.prepare('INSERT INTO user_hidden (uid, item_id, at) VALUES (?1, ?2, ?3) ON CONFLICT(uid, item_id) DO UPDATE SET at = ?3').bind(ctx.user.id, it.id, Date.now()).run();
  return json({ ok: true, id: it.id });
});

route('DELETE', '/api/hidden/:id', async ({ db, user, params }) => {
  await db.prepare('DELETE FROM user_hidden WHERE uid = ?1 AND item_id = ?2').bind(user.id, params.id).run();
  return json({ ok: true });
});

/* ---------- бухгалтерия ---------- */

// Главная страница бухгалтера показывает операции только за текущий день (по UTC+3), баланс считается по всей истории.
route('GET', '/api/ledger', async ({ db, user, query }) => {
  const limit = intParam(query.limit, 200, 1, 500);
  const from = dayStartOf(Date.now());
  const [t, rows, day] = await Promise.all([
    totals(db, user),
    db.prepare('SELECT id, type, amount, note, ts FROM ledger WHERE uid = ?1 AND ts >= ?2 ORDER BY ts DESC, rowid DESC LIMIT ?3').bind(user.id, from, limit).all(),
    dayTotals(db, user, from, from + DAY_MS)
  ]);
  return json({ start: user.ledger_start, ...t, day: { from, to: from + DAY_MS, income: day.earned, expense: day.spent, count: day.incomeCount + day.expenseCount }, entries: rows.results || [] });
});

// Архив: прошлые дни с итогами. Сами операции дня подгружаются отдельно.
route('GET', '/api/ledger/archive', async ({ db, user }) => {
  const today = dayStartOf(Date.now());
  const rows = (await db.prepare(`SELECT (ts + ${TZ_OFFSET}) / ${DAY_MS} AS d, type, COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c FROM ledger WHERE uid = ?1 AND ts < ?2 GROUP BY d, type ORDER BY d ASC`).bind(user.id, today).all()).results || [];
  const days = new Map();
  for (const r of rows) {
    const key = Number(r.d);
    const d = days.get(key) || { day: key * DAY_MS - TZ_OFFSET, earned: 0, spent: 0, count: 0 };
    if (r.type === 'income') d.earned = r.s;
    else d.spent = r.s;
    d.count += r.c;
    days.set(key, d);
  }
  let balance = user.ledger_start;
  const list = [...days.values()].map((d) => {
    d.net = d.earned - d.spent;
    balance += d.net;
    d.balanceEnd = balance;
    return d;
  });
  return json({ today, days: list.reverse().slice(0, 1000) });
});

route('GET', '/api/ledger/archive/:day', async ({ db, user, params }) => {
  const day = Number(params.day);
  if (!Number.isFinite(day)) throw bad('Неверная дата');
  const from = dayStartOf(day);
  const [rows, t] = await Promise.all([
    db.prepare('SELECT id, type, amount, note, ts FROM ledger WHERE uid = ?1 AND ts >= ?2 AND ts < ?3 ORDER BY ts DESC, rowid DESC LIMIT 1000').bind(user.id, from, from + DAY_MS).all(),
    dayTotals(db, user, from, from + DAY_MS)
  ]);
  return json({ day: from, ...t, entries: rows.results || [] });
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
  const r = await db.prepare('DELETE FROM ledger WHERE id = ?1 AND uid = ?2 AND ts >= ?3').bind(params.id, user.id, dayStartOf(Date.now())).run();
  if (!r.meta.changes) {
    const old = await db.prepare('SELECT 1 FROM ledger WHERE id = ?1 AND uid = ?2').bind(params.id, user.id).first();
    if (old) throw bad('Операции из архива удалить нельзя', 403);
  }
  if (!r.meta.changes) throw bad('Операция не найдена', 404);
  return json(await totals(db, user));
});

// Итог за день. Без параметров: текущий день по UTC+3; ?day=<мс> — день, в который попадает метка времени.
route('GET', '/api/ledger/summary', async ({ db, user, query }) => {
  let from;
  let to;
  if (query.from !== undefined || query.to !== undefined) {
    from = Number(query.from);
    to = Number(query.to);
  } else {
    // без параметров: текущий день по UTC+3 (или день, указанный параметром day)
    from = dayStartOf(query.day !== undefined && Number.isFinite(Number(query.day)) ? Number(query.day) : Date.now());
    to = from + DAY_MS;
  }
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

// Сырой текст ошибки (может содержать куски ответов EXBO) наружу не отдаём: только лимит API или общая фраза.
const publicError = (e) => (!e ? '' : String(e).startsWith('Лимит API') ? e : 'Ошибка сканера, подробности в логах сервера');

route('GET', '/api/auction/status', async (ctx) => {
  const s = await cached('status', 12000, async () => getStatus(ctx.db, { config: ctx.config, catalog: await catalogOf(ctx) }));
  return json({ ...s, lastError: publicError(s.lastError) });
});

route('GET', '/api/auction/feed', async (ctx) => {
  const { db, config, query } = ctx;
  const region = regionParam(config, query.region);
  const after = Number(query.after) || 0;
  const limit = intParam(query.limit, 40, 1, 100);
  const catalog = await catalogOf(ctx);
  return json(await cached(`feed:${region}:${after}:${limit}`, 4000, () => getFeed(db, { region, after, limit, exclude: catalog.hidden })));
});

route('GET', '/api/auction/deals', async (ctx) => {
  const { db, config, query } = ctx;
  const region = regionParam(config, query.region);
  const limit = intParam(query.limit, 6, 1, 12);
  const catalog = await catalogOf(ctx);
  return json({ items: await cached(`deals:${region}:${limit}`, 15000, () => getDeals(db, { region, limit, exclude: catalog.hidden })) });
});

// Сырые данные лотов оружейного модуля (сохраняются при первом сканировании): по ним видно, где в ответе EXBO лежит название модуля.
route('GET', '/api/auction/module-samples', async ({ db }) => {
  const row = await db.prepare("SELECT v FROM meta WHERE k = 'mod_samples'").first();
  let samples = [];
  try {
    samples = row ? JSON.parse(row.v) : [];
  } catch (_) {}
  return json({ samples });
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
    const byCron = Boolean(config.tickSecret) && typeof secret === 'string' && timingSafeEqual(secret, config.tickSecret);
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
    // Бухгалтер зависит от ledger_start, который можно изменить в другом экземпляре, поэтому там кэш сессии не используем.
    const user = await userFromRequest(env.DB, request, { fresh: path.startsWith('/api/ledger') });
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
