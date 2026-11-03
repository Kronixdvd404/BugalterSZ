import { bad, randomHex, sha256Hex, toHex, fromHex, timingSafeEqual } from './util.js';

export const COOKIE = 'sz_sid';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
export const NICK_RE = /^[A-Za-z0-9А-Яа-яЁё_.\-]{3,20}$/;

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

/** Формат хранения: pbkdf2$итерации$соль$хеш (число итераций можно менять позже, старые пароли продолжат работать). */
export async function hashPassword(password, iter) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iter}$${toHex(salt)}$${await pbkdf2(password, salt, iter)}`;
}

export async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = String(stored || '').split('$');
  if (kind !== 'pbkdf2' || !iter || !salt || !hash) return false;
  return timingSafeEqual(await pbkdf2(password, fromHex(salt), Number(iter)), hash);
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

export function cookieHeader(value, maxAge, secure) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export async function startSession(db, user, secure) {
  const token = randomHex(32);
  const exp = Date.now() + SESSION_TTL;
  await db.prepare('INSERT INTO sessions (token_hash, uid, exp) VALUES (?, ?, ?)').bind(await sha256Hex(token), user.id, exp).run();
  // Заодно чистим просроченные сессии (дёшево: по индексу).
  await db.prepare('DELETE FROM sessions WHERE exp < ?').bind(Date.now()).run();
  return cookieHeader(token, SESSION_TTL / 1000, secure);
}

export async function endSession(db, request, secure) {
  const token = parseCookies(request.headers.get('cookie'))[COOKIE];
  if (token) {
    const hash = await sha256Hex(token);
    sessionCache.delete(hash);
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
  }
  return cookieHeader('', 0, secure);
}

// Короткий кэш проверки сессии в памяти: без него каждый запрос страницы (опрос ленты и т.п.) читает базу ради куки.
// Если сервер запущен в нескольких экземплярах (Cloudflare), у каждого свой кэш; после выхода из аккаунта
// чужой экземпляр может принять старую куку до SESSION_CACHE_MS, но сама кука у пользователя уже стёрта.
const SESSION_CACHE_MS = 30 * 1000;
const sessionCache = new Map();

/** fresh = true читает базу в обход кэша (нужно там, где важен актуальный ledger_start). */
export async function userFromRequest(db, request, { fresh = false } = {}) {
  const token = parseCookies(request.headers.get('cookie'))[COOKIE];
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

/** 10 попыток входа/регистрации в минуту с одного IP. */
export async function limitAuth(db, request) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now();
  const r = await db.prepare('SELECT COUNT(*) AS n FROM auth_hits WHERE ip = ? AND ts > ?').bind(ip, now - 60000).first();
  if (r && r.n >= 10) throw bad('Слишком много попыток, подожди минуту', 429);
  await db.batch([db.prepare('INSERT INTO auth_hits (ip, ts) VALUES (?, ?)').bind(ip, now), db.prepare('DELETE FROM auth_hits WHERE ts < ?').bind(now - 10 * 60000)]);
}
