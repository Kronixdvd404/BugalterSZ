import { makeBlacklist } from './blacklist.js';

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : d;
};
const flag = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());

/** Настройки берутся из переменных окружения Cloudflare (env). */
export function getConfig(env) {
  const hasCreds = Boolean(env.EXBO_TOKEN || (env.EXBO_CLIENT_ID && env.EXBO_CLIENT_SECRET));
  const forceDemo = flag(env.DEMO);
  const regions = String(env.REGIONS || 'ru,eu')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ['ru', 'eu', 'na', 'sea'].includes(s));

  return {
    demo: forceDemo || !hasCreds,
    demoReason: forceDemo ? 'включён вручную' : !hasCreds ? 'не заданы EXBO_CLIENT_ID / EXBO_CLIENT_SECRET' : '',
    regions: regions.length ? regions : ['ru', 'eu'],
    pbkdf2Iter: Math.max(10000, Math.min(100000, num(env.PBKDF2_ITER, 100000))), // 100000 — максимум в Workers
    tickSecret: env.TICK_SECRET || '',
    pepper: String(env.PASSWORD_PEPPER || ''), // секрет для HMAC пароля перед PBKDF2 (не терять: без него хеши с перцем не проверить)
    hibp: !flag(env.HIBP_OFF), // проверка пароля по базе утечек Have I Been Pwned (отправляется только 5 символов SHA-1)
    regPerHour: Math.max(1, Math.min(100, num(env.REG_PER_HOUR, 5))), // регистраций в час с одного IP
    blacklist: makeBlacklist(env), // предметы, скрытые из ленты (src/blacklist.js)
    moduleItems: String(env.MODULE_ITEMS || '').split(',').map((s) => s.trim()).filter(Boolean), // id предметов с названиями модулей, помимо категории weapon_modules
    backgroundScan: flag(env.BACKGROUND_SCAN), // на своём сервере сканер крутится сам, вкладки его не дёргают
    exbo: {
      clientId: env.EXBO_CLIENT_ID || '',
      clientSecret: env.EXBO_CLIENT_SECRET || '',
      token: env.EXBO_TOKEN || '',
      baseUrl: (env.EXBO_BASE_URL || 'https://eapi.stalcraft.net').replace(/\/+$/, ''),
      tokenUrl: env.EXBO_TOKEN_URL || 'https://exbo.net/oauth/token',
      iconBase: (env.ICON_BASE || 'https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru').replace(/\/+$/, ''),
      ratePerMin: Math.max(10, num(env.RATE_LIMIT_PER_MIN, 240))
    },
    scanner: {
      // Сколько предметов обрабатывает один «тик». Лимит подзапросов Workers: 50 на бесплатном плане.
      batch: Math.max(2, Math.min(40, num(env.SCAN_BATCH, 10))),
      historyBudget: Math.max(1, Math.min(30, num(env.SCAN_HISTORY_BUDGET, 8))),
      backfillMs: Math.max(0, num(env.FEED_BACKFILL_MIN, 10)) * 60000,
      dealMin: num(env.DEAL_MIN, 0.15),
      dealMinSamples: Math.max(2, num(env.DEAL_MIN_SAMPLES, 5)),
      dealMinSavings: Math.max(0, num(env.DEAL_MIN_SAVINGS, 1000)),
      // Насколько вниз по заточке можно расширять сравнение, если точных продаж мало (0 — только точная заточка)
      ptnWindow: Math.max(0, Math.min(5, num(env.DEAL_PTN_WINDOW, 2))),
      historyPrice: ['unit', 'total'].includes(String(env.HISTORY_PRICE || '').toLowerCase()) ? String(env.HISTORY_PRICE).toLowerCase() : 'auto',
      historyPages: Math.max(1, Math.min(3, num(env.HISTORY_PAGES, 2))),
      feedSize: 400
    }
  };
}
