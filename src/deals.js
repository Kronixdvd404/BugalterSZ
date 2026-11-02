/*
 * Оценка выгодности лота. Чистые функции, без обращений к сети и базе: их можно тестировать в Node.
 *
 * Лот сравнивается только с продажами того же предмета, у которых совпадает КАЧЕСТВО (qlt: 0 обычный …
 * 5 легендарный) и ЗАТОЧКА (ptn: +0 … +15). Для сравнения берётся медиана цены за штуку.
 *
 * У оружейных модулей сначала сравнивается НАЗВАНИЕ модуля («Снайпер», «Пробойник» …), и только потом качество:
 * модули с разными названиями это фактически разные предметы с разной ценой.
 *
 * Если точных продаж (то же качество и та же заточка) мало, окно расширяется только ВНИЗ по заточке:
 * +5 можно сравнить с +4 и +3, но не с +6. Продажи с меньшей заточкой стоят дешевле, поэтому
 * такая медиана может только занизить «справедливую» цену и не создаёт ложных выгодных лотов.
 */

export const asc = (a, b) => a - b;

export function median(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const isNum = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));

/** Определяет, что лежит в price истории продаж: цена за штуку ('unit') или за весь лот ('total'). */
export function detectMode(rows, refLots, forced = 'auto') {
  if (forced === 'unit' || forced === 'total') return forced;
  const multi = rows.filter((r) => r.amount > 1);
  const lotsMulti = refLots.filter((l) => l.buyoutPrice > 0 && l.amount > 1);
  if (multi.length < 3 || lotsMulti.length < 3) return 'total';
  const ref = median(lotsMulti.map((l) => l.buyoutPrice / l.amount).sort(asc));
  const asUnit = median(multi.map((r) => r.price).sort(asc));
  const asTotal = median(multi.map((r) => r.price / r.amount).sort(asc));
  if (!ref || !asUnit || !asTotal) return 'total';
  return Math.abs(Math.log(asUnit / ref)) < Math.abs(Math.log(asTotal / ref)) ? 'unit' : 'total';
}

/**
 * Строит опорные данные из истории продаж. Результат — простой JSON (хранится в базе).
 * pts: [время, цена за штуку, качество|null, заточка|null, название модуля|null]
 */
export function buildBaseline(sales, refLots, { maxAgeMs, maxSales = 400, forcedMode = 'auto', now = Date.now() } = {}) {
  const rows = sales.filter((s) => s.price > 0 && (!s.time || !maxAgeMs || now - s.time < maxAgeMs)).slice(0, maxSales);
  const mode = detectMode(rows, refLots, forcedMode);
  const pts = rows.map((s) => [s.time || 0, Math.round((mode === 'total' ? s.price / s.amount : s.price) * 100) / 100, isNum(s.qlt) ? Number(s.qlt) : null, isNum(s.ptn) ? Number(s.ptn) : null, s.mod || null]);
  return { at: now, ok: pts.length > 0, mode, pts };
}

/** Ключ группы: название модуля (если есть), затем качество и заточка. У предметов без качества (аптечки, патроны) группа одна. */
const groupKey = (q, p, m = null) => (m ? m + '|' : '') + (q === null ? 'n' : q + ':' + (p === null ? 0 : p));

/**
 * Индекс по группам для быстрых сравнений. Строится один раз на предмет за сканирование.
 * opts: { minSamples, ptnWindow }
 */
export function makeIndex(base, opts) {
  const groups = new Map(); // "q:p" -> отсортированные цены
  const hasQuality = base.pts.some((p) => p[2] !== null);
  const hasPtn = base.pts.some((p) => p[3] !== null); // если API не отдаёт заточку в истории, заточенные лоты не оцениваем
  const hasMod = base.pts.some((p) => p[4]); // в истории есть названия модулей
  const meta = new Map(); // ключ группы -> [модуль, качество, заточка] для сводки
  for (const [, unit, q, p, m] of base.pts) {
    const k = groupKey(q, p, m || null);
    if (!groups.has(k)) {
      groups.set(k, []);
      meta.set(k, [m || null, q, p === null ? (q === null ? null : 0) : p]);
    }
    groups.get(k).push(unit);
  }
  for (const arr of groups.values()) arr.sort(asc);
  const cache = new Map();

  function stat(arr, basis) {
    return { median: median(arr), p25: quantile(arr, 0.25), samples: arr.length, basis };
  }

  /** Опорная цена для лота или null, если честно сравнить не с чем. */
  function ref(lot) {
    const q = isNum(lot.qlt) ? Number(lot.qlt) : null;
    const p = isNum(lot.ptn) ? Number(lot.ptn) : null;
    const m = lot.mod || null;
    // Модуль без названия или история без названий: честно сравнить не с чем (модули стоят по-разному).
    if (hasMod && !m) return null;
    if (m && !hasMod) return null;
    // У предмета качество есть в продажах, а у лота нет (или наоборот): сравнение было бы нечестным.
    if (hasQuality && q === null) return null;
    if (hasQuality && !hasPtn && p !== null && p > 0) return null;
    const ck = groupKey(q, p, m);
    if (cache.has(ck)) return cache.get(ck);

    let out = null;
    const exact = groups.get(ck) || [];
    if (exact.length >= opts.minSamples) out = stat(exact, { mod: m, qlt: q, ptn: q === null ? null : p === null ? 0 : p, exact: true });
    else if (q !== null) {
      const pl = p === null ? 0 : p;
      for (let w = 1; w <= opts.ptnWindow && pl - w >= 0 && !out; w++) {
        let merged = [];
        for (let x = pl - w; x <= pl; x++) merged = merged.concat(groups.get(groupKey(q, x, m)) || []);
        if (merged.length >= opts.minSamples) out = stat(merged.sort(asc), { mod: m, qlt: q, ptn: pl, ptnFrom: pl - w, exact: false });
      }
    }
    cache.set(ck, out);
    return out;
  }

  /** Сводка по группам для страницы предмета: [[q, p, медиана, продаж, модуль]]. Порядок: модуль, качество, заточка. */
  function summary() {
    const out = [];
    for (const [k, arr] of groups) {
      const [m, q, p] = meta.get(k);
      out.push([q, p, Math.round(median(arr)), arr.length, m]);
    }
    return out.sort((a, b) => String(a[4] || '').localeCompare(String(b[4] || ''), 'ru') || (a[0] ?? -1) - (b[0] ?? -1) || (a[1] ?? 0) - (b[1] ?? 0));
  }

  return { ref, summary, hasQuality, hasMod };
}

/** Сравнивает цену лота за штуку с опорной ценой. null — если сравнивать не с чем. */
export function evaluate(index, lot) {
  if (!index || !(lot.buyoutPrice > 0)) return null;
  const r = index.ref(lot);
  if (!r || !r.median) return null;
  const unit = lot.buyoutPrice / lot.amount;
  return { median: r.median, p25: r.p25, samples: r.samples, basis: r.basis, discount: 1 - unit / r.median, savings: (r.median - unit) * lot.amount };
}

/** Дешевле 10% медианы — почти всегда ошибка продавца или данных, а не выгода. */
export const DEAL_MAX_DISCOUNT = 0.9;

export function isDeal(d, lot, { dealMin, dealMinSavings }, now = Date.now()) {
  return d.discount >= dealMin && d.discount <= DEAL_MAX_DISCOUNT && d.savings >= dealMinSavings && (!lot.endTime || lot.endTime > now);
}
