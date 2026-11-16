import { bad, randomHex, sha256Hex, toHex, fromHex, timingSafeEqual } from './util.js';

export const COOKIE = 'sz_sid'; // прежнее имя: принимается, пока у людей остались старые сессии
export const COOKIE_HOST = '__Host-sz_sid'; // по https: префикс __Host- запрещает подмену куки с поддомена
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const MAX_SESSIONS = 10; // одновременно открытых сессий на аккаунт
export const NICK_RE = /^[A-Za-z0-9А-Яа-яЁё_.\-]{3,20}$/;

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

/** «Перец»: HMAC-SHA256 пароля секретом из окружения. Без секрета одна утёкшая база не даёт перебирать пароли. */
async function withPepper(password, pepper) {
  if (!pepper) return password;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(password)));
}

/**
 * Формат хранения: вид$итерации$соль$хеш.
 * pbkdf2 это пароль без перца (старые записи), pbkdf2p1 это пароль с перцем. Число итераций и вид можно менять позже:
 * старые пароли продолжат работать и обновятся при следующем входе (needsRehash).
 */
export async function hashPassword(password, iter, pepper = '') {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kind = pepper ? 'pbkdf2p1' : 'pbkdf2';
  return `${kind}$${iter}$${toHex(salt)}$${await pbkdf2(await withPepper(password, pepper), salt, iter)}`;
}

export async function verifyPassword(password, stored, pepper = '') {
  const [kind, iter, salt, hash] = String(stored || '').split('$');
  if ((kind !== 'pbkdf2' && kind !== 'pbkdf2p1') || !iter || !salt || !hash) return false;
  if (kind === 'pbkdf2p1' && !pepper) return false; // перец потерян или не задан: проверить нечем
  const input = kind === 'pbkdf2p1' ? await withPepper(password, pepper) : password;
  return timingSafeEqual(await pbkdf2(input, fromHex(salt), Number(iter)), hash);
}

/** Пора ли пересчитать хеш при входе: появился перец или число итераций выросло. */
export function needsRehash(stored, iter, pepper = '') {
  const [kind, it] = String(stored || '').split('$');
  if (pepper && kind !== 'pbkdf2p1') return true;
  return Number(it) < iter;
}

export function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((p) => {
      const i = p.indexOf('=');
      if (i > 0) {
        try {
          out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
        } catch (_) {}
      }
    });
  return out;
}

/** Токены сессии из запроса: сначала новая кука __Host-, потом прежняя. */
const tokensOf = (request) => {
  const c = parseCookies(request.headers.get('cookie'));
  return [c[COOKIE_HOST], c[COOKIE]].filter(Boolean);
};

export function cookieHeader(value, maxAge, secure) {
  const name = secure ? COOKIE_HOST : COOKIE;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
// По https прежнюю куку sz_sid заодно стираем, чтобы она не висела в браузере.
const legacyClear = (secure) => (secure ? [`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`] : []);

export async function startSession(db, user, secure) {
  const token = randomHex(32);
  const now = Date.now();
  const exp = now + SESSION_TTL;
  // Не больше MAX_SESSIONS сессий на аккаунт: самые старые закрываются. Заодно чистим просроченные.
  await db.prepare('DELETE FROM sessions WHERE uid = ?1 AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE uid = ?1 AND exp > ?2 ORDER BY exp DESC LIMIT ?3)').bind(user.id, now, MAX_SESSIONS - 1).run();
  await db.prepare('INSERT INTO sessions (token_hash, uid, exp) VALUES (?, ?, ?)').bind(await sha256Hex(token), user.id, exp).run();
  await db.prepare('DELETE FROM sessions WHERE exp < ?').bind(now).run();
  return [cookieHeader(token, SESSION_TTL / 1000, secure), ...legacyClear(secure)];
}

export async function endSession(db, request, secure) {
  for (const token of tokensOf(request)) {
    const hash = await sha256Hex(token);
    sessionCache.delete(hash);
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
  }
  return clearSessionCookies(secure);
}

export const clearSessionCookies = (secure) => [cookieHeader('', 0, secure), ...legacyClear(secure)];

/** Хеш токена текущей сессии (нужен, чтобы при смене пароля оставить только её). */
export async function currentTokenHash(request) {
  const t = tokensOf(request)[0];
  return t ? sha256Hex(t) : null;
}

/** Закрывает сессии аккаунта: все или все, кроме одной. */
export async function dropUserSessions(db, uid, exceptHash = null) {
  for (const [k, v] of sessionCache) if (v.user.id === uid && k !== exceptHash) sessionCache.delete(k);
  if (exceptHash) await db.prepare('DELETE FROM sessions WHERE uid = ?1 AND token_hash != ?2').bind(uid, exceptHash).run();
  else await db.prepare('DELETE FROM sessions WHERE uid = ?1').bind(uid).run();
}

// Короткий кэш проверки сессии в памяти: без него каждый запрос страницы (опрос ленты и т.п.) читает базу ради куки.
// Если сервер запущен в нескольких экземплярах (Cloudflare), у каждого свой кэш; после выхода из аккаунта
// чужой экземпляр может принять старую куку до SESSION_CACHE_MS, но сама кука у пользователя уже стёрта.
const SESSION_CACHE_MS = 30 * 1000;
const sessionCache = new Map();

/** fresh = true читает базу в обход кэша (нужно там, где важен актуальный ledger_start). */
export async function userFromRequest(db, request, { fresh = false } = {}) {
  const token = tokensOf(request)[0];
  if (!token) return null;
  const hash = await sha256Hex(token);
  const now = Date.now();
  if (!fresh) {
    const hit = sessionCache.get(hash);
    if (hit && hit.until > now && hit.exp > now) return { ...hit.user };
    if (hit) sessionCache.delete(hash);
  }
  const row = await db
    .prepare('SELECT u.id, u.nick, u.ledger_start, s.exp AS sess_exp FROM sessions s JOIN users u ON u.id = s.uid WHERE s.token_hash = ? AND s.exp > ?')
    .bind(hash, now)
    .first();
  if (!row) {
    sessionCache.delete(hash);
    return null;
  }
  const { sess_exp: exp, ...user } = row;
  if (sessionCache.size > 500) sessionCache.clear();
  sessionCache.set(hash, { user, exp: Number(exp) || 0, until: now + SESSION_CACHE_MS });
  return { ...user };
}

export const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'local';

/** 10 попыток входа/регистрации в минуту с одного IP. */
export async function limitAuth(db, request) {
  const ip = clientIp(request);
  const now = Date.now();
  const r = await db.prepare('SELECT COUNT(*) AS n FROM auth_hits WHERE ip = ? AND ts > ?').bind(ip, now - 60000).first();
  if (r && r.n >= 10) throw bad('Слишком много попыток, подожди минуту', 429);
  await db.batch([db.prepare('INSERT INTO auth_hits (ip, ts) VALUES (?, ?)').bind(ip, now), db.prepare('DELETE FROM auth_hits WHERE ts < ?').bind(now - 10 * 60000)]);
}

/* ---------- защита от подбора пароля и массовой регистрации ----------
 * Если таблицы ещё нет (схему не обновили командой npm run db:turso), защита молча отключается, а вход и регистрация работают. */

const FAIL_WINDOW = 15 * 60000;
const FAIL_PER_IP = 5; // неудач с одного IP на один ник, после этого пауза растёт: 30 с, 1 мин, 2 мин … до 15 мин
const FAIL_PER_NICK = 20; // неудач на один ник со всех IP вместе (распределённый подбор)

/** Бросает 429, если по этому нику слишком много неудачных попыток. */
export async function checkLoginLock(db, nickLc, ip) {
  const now = Date.now();
  let r = null;
  try {
    r = await db
      .prepare('SELECT COUNT(*) AS n, MAX(ts) AS last, SUM(CASE WHEN ip = ?3 THEN 1 ELSE 0 END) AS ipn, MAX(CASE WHEN ip = ?3 THEN ts END) AS iplast FROM auth_fail WHERE nick_lc = ?1 AND ts > ?2')
      .bind(nickLc, now - FAIL_WINDOW, ip)
      .first();
  } catch (e) {
    console.error('[auth] auth_fail недоступна:', e && e.message);
    return;
  }
  if (!r) return;
  const ipn = Number(r.ipn) || 0;
  const n = Number(r.n) || 0;
  let until = 0;
  if (ipn >= FAIL_PER_IP) until = Math.max(until, Number(r.iplast) + Math.min(FAIL_WINDOW, 30000 * 2 ** (ipn - FAIL_PER_IP)));
  if (n >= FAIL_PER_NICK) until = Math.max(until, Number(r.last) + Math.min(FAIL_WINDOW, 60000 * 2 ** (n - FAIL_PER_NICK)));
  if (until > now) throw bad('Слишком много неудачных попыток входа, подождите несколько минут', 429);
}

export async function recordLoginFail(db, nickLc, ip) {
  const now = Date.now();
  try {
    await db.batch([db.prepare('INSERT INTO auth_fail (nick_lc, ip, ts) VALUES (?, ?, ?)').bind(nickLc, ip, now), db.prepare('DELETE FROM auth_fail WHERE ts < ?').bind(now - 60 * 60000)]);
  } catch (e) {
    console.error('[auth] не записана неудача входа:', e && e.message);
  }
}

export async function clearLoginFails(db, nickLc, ip) {
  try {
    await db.prepare('DELETE FROM auth_fail WHERE nick_lc = ? AND ip = ?').bind(nickLc, ip).run();
  } catch (_) {}
}

/** Не больше perHour новых аккаунтов в час с одного IP. */
export async function limitRegistration(db, request, perHour) {
  const ip = clientIp(request);
  try {
    const r = await db.prepare('SELECT COUNT(*) AS n FROM reg_hits WHERE ip = ? AND ts > ?').bind(ip, Date.now() - 3600000).first();
    if (r && r.n >= perHour) throw bad('Слишком много регистраций с вашего адреса, попробуйте позже', 429);
  } catch (e) {
    if (e && e.status === 429) throw e;
    console.error('[auth] reg_hits недоступна:', e && e.message);
  }
}

export async function recordRegistration(db, request) {
  const now = Date.now();
  try {
    await db.batch([db.prepare('INSERT INTO reg_hits (ip, ts) VALUES (?, ?)').bind(clientIp(request), now), db.prepare('DELETE FROM reg_hits WHERE ts < ?').bind(now - 3600000)]);
  } catch (e) {
    console.error('[auth] регистрация не записана:', e && e.message);
  }
}
