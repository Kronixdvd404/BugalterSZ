/*
 * Демо-рынок: тот же интерфейс, что у ExboApi, но данные выдуманные.
 * Нужен, чтобы приложение можно было посмотреть без ключей EXBO.
 *
 * Рынок детерминированный (зависит только от времени), потому что на Cloudflare каждый запрос
 * может обработать новый экземпляр воркера и хранить случайное состояние в памяти нельзя.
 */

export const CATALOG = [
  // [id, название, базовая цена, артефакт?]
  ['d_medkit', 'Аптечка армейская', 3200, 0],
  ['d_bandage', 'Бинт', 450, 0],
  ['d_stim', 'Боевой стимулятор', 7800, 0],
  ['d_ak74', 'АК-74', 48000, 0],
  ['d_akm', 'АКМ', 56000, 0],
  ['d_svd', 'СВД', 185000, 0],
  ['d_val', 'АС «Вал»', 420000, 0],
  ['d_vss', 'ВСС «Винторез»', 390000, 0],
  ['d_pm', 'ПМ', 9500, 0],
  ['d_tt', 'ТТ', 14000, 0],
  ['d_mp5', 'MP5', 76000, 0],
  ['d_sks', 'СКС', 61000, 0],
  ['d_m4', 'M4A1', 240000, 0],
  ['d_mosin', 'Винтовка Мосина', 33000, 0],
  ['d_sunrise', 'Комбинезон «Заря»', 125000, 0],
  ['d_seva', 'Костюм СЕВА', 310000, 0],
  ['d_exo', 'Экзоскелет «Ратник»', 1650000, 0],
  ['d_helm', 'Шлем «Сфера»', 88000, 0],
  ['d_vest', 'Бронежилет «Корунд»', 270000, 0],
  ['d_mask', 'Противогаз ГП-7', 12500, 0],
  ['d_cartridge545', 'Патроны 5.45×39', 40, 0],
  ['d_cartridge762', 'Патроны 7.62×39', 55, 0],
  ['d_cartridge9', 'Патроны 9×18', 22, 0],
  ['d_grenade', 'Граната Ф-1', 2800, 0],
  ['d_detector', 'Детектор «Медведь»', 96000, 0],
  ['d_scanner', 'Сканер аномалий', 54000, 0],
  ['d_battery', 'Батарея', 1900, 0],
  ['d_scrap', 'Металлолом', 600, 0],
  ['d_circuit', 'Микросхема', 5200, 0],
  ['d_chem', 'Химические реагенты', 3700, 0],
  ['d_food', 'Консервы «Завтрак туриста»', 700, 0],
  ['d_vodka', 'Водка «Казаки»', 1500, 0],
  ['d_energy', 'Энергетик', 1100, 0],
  ['d_optic', 'Прицел ПСО-1', 38000, 0],
  ['d_silencer', 'Глушитель ПБС', 27000, 0],
  ['d_mag', 'Магазин расширенный', 9000, 0],
  ['d_backpack', 'Рюкзак «Тактик»', 64000, 0],
  ['d_knife', 'Нож «Финка»', 8800, 0],
  ['d_gold', 'Золотая подвеска', 15000, 0],
  ['d_poster', 'Раритетный плакат', 23000, 0],
  ['d_art_soul', 'Душа', 210000, 1],
  ['d_art_flash', 'Вспышка', 150000, 1],
  ['d_art_moon', 'Лунный свет', 180000, 1],
  ['d_art_crystal', 'Кристалл', 320000, 1],
  ['d_art_blood', 'Каменная кровь', 270000, 1],
  ['d_art_gravi', 'Гравий', 98000, 1],
  ['d_art_pellicle', 'Пленка', 76000, 1],
  ['d_art_urchin', 'Морской ёж', 135000, 1],
  ['d_art_jelly', 'Мамины бусы', 460000, 1],
  ['d_art_bat', 'Ночная звезда', 340000, 1]
];

const QLT_MULT = [1, 1.35, 1.9, 2.8, 4.5, 8]; // Обычный → Легендарный
const QLT_POOL = [0, 0, 1, 1, 2, 2, 3, 4, 5];
const PTN_POOL = [0, 0, 0, 1, 2, 3, 5, 5, 7, 10, 10, 12, 15];
const ptnMult = (p) => 1 + 0.08 * p; // +0 → ×1, +5 → ×1.4, +10 → ×1.8, +15 → ×2.2

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const round = (v) => {
  const step = v > 5000 ? 100 : v > 500 ? 10 : 1;
  return Math.max(1, Math.round(v / step) * step);
};
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

const MIN = 60000;
const HOUR = 3600 * 1000;
const MAX_DURATION = 12 * HOUR;

export class DemoApi {
  constructor() {
    this.requests = 0;
  }

  async listing() {
    return CATALOG.map(([id, name]) => ({ id, name, icon: '', color: '' }));
  }

  _spec(id) {
    return CATALOG.find((c) => c[0] === id);
  }

  _lotFor(spec, region, n, period) {
    const [id, , base, art] = spec;
    const r = mulberry32(hashStr(region + id + n));
    const regionMult = region === 'eu' ? 1.08 : 1;
    const startTime = n * period + Math.floor(r() * period * 0.9);
    const qlt = art ? pick(r, QLT_POOL) : null;
    const ptn = art ? pick(r, PTN_POOL) : null;
    const unit = base * regionMult * (art ? QLT_MULT[qlt] * ptnMult(ptn) : 1);
    const stack = base < 100 ? pick(r, [20, 60, 120, 300]) : r() < 0.12 ? 1 + Math.floor(r() * 5) : 1;
    let k = Math.exp(gauss(r) * 0.08);
    if (r() < 0.1) k = 0.5 + r() * 0.25; // выгодный лот
    const buyout = round(unit * k) * stack;
    const start = round(buyout * (0.55 + r() * 0.25));
    const endTime = startTime + pick(r, [2, 4, 8, 12]) * HOUR;
    return { amount: stack, startPrice: start, currentPrice: start, buyoutPrice: buyout, startTime, endTime, qlt, ptn };
  }

  _activeLots(region, id) {
    const spec = this._spec(id);
    if (!spec) return null;
    const now = Date.now();
    const period = (20 + (Math.abs(hashStr(id)) % 40)) * MIN; // новый лот примерно раз в 20–60 минут
    const out = [];
    for (let n = Math.floor((now - MAX_DURATION) / period); n <= Math.floor(now / period); n++) {
      const l = this._lotFor(spec, region, n, period);
      if (l.startTime <= now && l.endTime > now) out.push(l);
    }
    return out.slice(-40);
  }

  async lots(region, id, { limit = 200, offset = 0, sort = 'time_created', order = 'desc' } = {}) {
    this.requests++;
    const all = this._activeLots(region, id);
    if (!all) return { total: 0, lots: [] };
    const keyFn = { time_created: (l) => l.startTime, current_price: (l) => l.currentPrice, buyout_price: (l) => l.buyoutPrice || Infinity, time_left: (l) => l.endTime }[sort] || ((l) => l.startTime);
    const sorted = [...all].sort((a, b) => (order === 'asc' ? keyFn(a) - keyFn(b) : keyFn(b) - keyFn(a)));
    return { total: sorted.length, lots: sorted.slice(offset, offset + limit) };
  }

  async history(region, id, { limit = 200, offset = 0 } = {}) {
    this.requests++;
    const spec = this._spec(id);
    if (!spec) return { total: 0, sales: [] };
    const r = mulberry32(hashStr(region + id));
    const [, , base, art] = spec;
    const regionMult = region === 'eu' ? 1.08 : 1;
    const now = Date.now();
    const sales = [];
    let t = now - 20 * MIN;
    let drift = 1;
    for (let i = 0; i < 400; i++) {
      drift = Math.max(0.85, Math.min(1.15, drift + gauss(r) * 0.01));
      const qlt = art ? pick(r, QLT_POOL) : null;
      const ptn = art ? pick(r, PTN_POOL) : null;
      const unit = base * regionMult * drift * (art ? QLT_MULT[qlt] * ptnMult(ptn) : 1) * Math.exp(gauss(r) * 0.07);
      const stack = base < 100 ? pick(r, [20, 60, 120, 300]) : r() < 0.12 ? 1 + Math.floor(r() * 5) : 1;
      sales.push({ amount: stack, price: round(unit) * stack, time: Math.round(t), qlt, ptn });
      t -= (0.15 + r() * 0.9) * HOUR;
    }
    return { total: sales.length, sales: sales.slice(offset, offset + limit) };
  }
}
