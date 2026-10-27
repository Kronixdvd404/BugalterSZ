/*
 * Сканер аукциона для Cloudflare.
 *
 * EXBO API отдаёт лоты только по одному предмету, общей ленты нет. На Cloudflare нет процесса,
 * который работает постоянно, поэтому сканирование идёт «тиками»: открытая страница раз в несколько
 * секунд вызывает POST /api/auction/tick, а тик обрабатывает небольшую пачку предметов
 * (горячие, у которых есть лоты, плюс очередная порция каталога по кругу) и пишет результат в D1.
 * Блокировка (lease) в таблице meta не даёт нескольким вкладкам делать тики одновременно
 * и держит общий темп запросов к EXBO в пределах RATE_LIMIT_PER_MIN.
 */
import { buildBaseline, makeIndex, evaluate, isDeal, median, quantile } from './deals.js';

const BASELINE_TTL = 45 * 60 * 1000;
const BASELINE_FAIL_TTL = 5 * 60 * 1000;
const SALES_MAX_AGE = 14 * 24 * 3600 * 1000;
const HOT_MIN_AGE = 40 * 1000; // не чаще раза в 40 с на предмет
const LEASE_CRASH_GUARD = 20 * 1000;
const LEASE_FLOOR = 1200;

/* ---------------- каталог ---------------- */

let catalogMem = { key: '', data: null };

function makeCatalog(items) {
  return {
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    index: items.map((i) => ({ item: i, low: i.name.toLowerCase().replace(/ё/g, 'е') }))
  };
}

/** Каталог лежит в public/catalog.json (его собирает `npm run build`). В демо — встроенный. */
export async function loadCatalog({ env, request, config, demoApi }) {
  const key = config.demo ? 'demo' : 'live';
  if (catalogMem.key === key && catalogMem.data) return catalogMem.data;
  let items;
  if (config.demo) items = await demoApi.listing();
  else {
    const res = await env.ASSETS.fetch(new URL('/catalog.json', request.url));
    if (!res.ok) throw new Error('Не найден catalog.json: выполните `npm run build` и задеплойте заново');
    const raw = await res.json();
    const base = config.exbo.iconBase;
    items = raw.map(([id, name, icon, color]) => ({ id, name, icon: icon ? base + icon : '', color: color || '' }));
  }
  catalogMem = { key, data: makeCatalog(items) };
  return catalogMem.data;
}

export function searchCatalog(catalog, q, limit = 12) {
  const needle = String(q || '').toLowerCase().replace(/ё/g, 'е').trim();
  if (!needle) return [];
  const words = needle.split(/\s+/);
  const scored = [];
  for (const { item, low } of catalog.index) {
    if (!words.every((w) => low.includes(w))) continue;
    const score = low.startsWith(needle) ? 0 : low.split(/[\s«»"(-]+/).some((w) => w.startsWith(words[0])) ? 1 : 2;
    scored.push([score, low.length, item]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, limit).map((s) => s[2]);
}

/* ---------------- вспомогательное ---------------- */

const lotKey = (l) => [l.startTime, l.buyoutPrice || l.currentPrice, l.amount, l.qlt, l.ptn].join('|');
const indexOpts = (sc) => ({ minSamples: sc.dealMinSamples, ptnWindow: sc.ptnWindow });

function entryOf(catalog, region, id, l, key, deal, now) {
  const it = catalog.byId.get(id);
  return {
    key,
    region,
    itemId: id,
    name: it ? it.name : id,
    icon: it ? it.icon : '',
    amount: l.amount,
    startPrice: l.startPrice,
    currentPrice: l.currentPrice,
    buyoutPrice: l.buyoutPrice,
    unit: l.buyoutPrice > 0 ? Math.round(l.buyoutPrice / l.amount) : 0,
    startTime: l.startTime,
    endTime: l.endTime,
    qlt: l.qlt,
    ptn: l.ptn,
    seenAt: now,
    deal: deal ? { median: Math.round(deal.median), discount: deal.discount, savings: Math.round(deal.savings), samples: deal.samples, basis: deal.basis } : null
  };
}

const setMeta = (db, k, v) => db.prepare('INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2').bind(k, String(v));
const addMeta = (db, k, n) => db.prepare('INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + ?2').bind(k, n);

/** История продаж: до historyPages страниц по 200. Вторая страница нужна предметам с качеством и заточкой. */
async function fetchBaseline(api, sc, region, id, refLots, budget, now) {
  let sales = [];
  for (let page = 0; page < sc.historyPages; page++) {
    if (page > 0) {
      if (budget.history <= 0) break;
      const last = sales[sales.length - 1];
      const hasQuality = sales.some((s) => s.qlt !== null);
      if (!hasQuality || sales.length < page * 200 || (last && last.time && now - last.time > SALES_MAX_AGE)) break;
    }
    budget.history--;
    const h = await api.history(region, id, { limit: 200, offset: page * 200 });
    sales = sales.concat(h.sales);
    if (h.sales.length < 200) break;
  }
  return buildBaseline(sales, refLots, { maxAgeMs: SALES_MAX_AGE, forcedMode: sc.historyPrice, now });
}

const baselineStmt = (db, k, b) =>
  db
    .prepare('INSERT INTO baselines (k, at, ok, data) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(k) DO UPDATE SET at = ?2, ok = ?3, data = ?4')
    .bind(k, b.at, b.ok ? 1 : 0, JSON.stringify({ mode: b.mode, pts: b.pts }));

function parseBaseline(row) {
  try {
    const d = JSON.parse(row.data);
    return { at: row.at, ok: Boolean(row.ok), mode: d.mode, pts: d.pts || [] };
  } catch (_) {
    return null;
  }
}

/* ---------------- тик ---------------- */

export async function tick({ db, api, config, catalog }) {
  const sc = config.scanner;
  const started = Date.now();

  // Блокировка: одновременно работает только один тик, и не чаще, чем позволяет лимит запросов.
  const lease = await db
    .prepare("INSERT INTO meta (k, v) VALUES ('lease', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1 WHERE CAST(meta.v AS INTEGER) <= ?2")
    .bind(String(started + LEASE_CRASH_GUARD), started)
    .run();
  if (!lease.meta || lease.meta.changes === 0) return { skipped: true };

  const items = catalog.items;
  const regions = config.regions;
  const N = items.length;
  if (!N) return { skipped: true, empty: true };
  const total = regions.length * N;

  const metaRows = (await db.prepare("SELECT k, v FROM meta WHERE k IN ('cursor', 'cycle_start')").all()).results || [];
  const meta = Object.fromEntries(metaRows.map((r) => [r.k, r.v]));
  const cursor = (Number(meta.cursor) || 0) % total;

  // План: сначала «горячие» предметы (у них есть лоты), остальное добирает обход каталога по кругу.
  const plan = new Map();
  const hotRows = (await db.prepare('SELECT k, region, item_id, seen FROM scan_state WHERE hot = 1 AND last_scan < ?1 ORDER BY last_scan ASC LIMIT ?2').bind(started - HOT_MIN_AGE, Math.floor(sc.batch / 2)).all()).results || [];
  for (const r of hotRows) plan.set(r.k, { k: r.k, region: r.region, id: r.item_id, prev: { seen: new Set(JSON.parse(r.seen || '[]')) } });
  const nCold = Math.max(1, sc.batch - plan.size);
  for (let i = 0; i < nCold; i++) {
    const idx = (cursor + i) % total;
    const region = regions[Math.floor(idx / N)];
    const id = items[idx % N].id;
    const k = region + ':' + id;
    if (!plan.has(k)) plan.set(k, { k, region, id, prev: null, cold: true });
  }
  const wrapped = cursor + nCold >= total;
  const newCursor = (cursor + nCold) % total;

  const keys = [...plan.keys()];
  const marks = keys.map((_, i) => '?' + (i + 1)).join(',');
  const coldKeys = [...plan.values()].filter((p) => p.cold).map((p) => p.k);
  const [stateRes, baseRes] = await db.batch([
    db.prepare(`SELECT k, seen FROM scan_state WHERE k IN (${coldKeys.map((_, i) => '?' + (i + 1)).join(',') || "''"})`).bind(...coldKeys),
    db.prepare(`SELECT k, at, ok, data FROM baselines WHERE k IN (${marks})`).bind(...keys)
  ]);
  for (const r of stateRes.results || []) {
    const p = plan.get(r.k);
    if (p) p.prev = { seen: new Set(JSON.parse(r.seen || '[]')) };
  }
  const baselines = new Map((baseRes.results || []).map((r) => [r.k, r]));

  const stmts = [];
  const budget = { history: sc.historyBudget };
  const stats = { scanned: 0, errors: 0, lastError: '', fresh: 0, deals: 0, rateLimit: 0 };
  let feedInserts = 0;

  async function scanOne(p) {
    const { k, region, id, prev } = p;
    const now = Date.now();
    let res;
    try {
      res = await api.lots(region, id, { limit: 200, sort: 'time_created', order: 'desc' });
    } catch (e) {
      if (e.status === 404) {
        if (prev) stmts.push(stateStmt(db, k, region, id, 0, now, []));
        return;
      }
      throw e;
    }
    stats.scanned++;
    const lots = res.lots;
    const keyed = lots.map((l) => ({ l, lk: lotKey(l) }));

    // Опорные цены по истории продаж. Нужны только если есть лоты с выкупом.
    let index = null;
    if (lots.some((l) => l.buyoutPrice > 0)) {
      const row = baselines.get(k);
      let base = row ? parseBaseline(row) : null;
      const age = base ? now - base.at : Infinity;
      if (!(base && age < (base.ok ? BASELINE_TTL : BASELINE_FAIL_TTL)) && budget.history > 0) {
        try {
          base = await fetchBaseline(api, sc, region, id, lots, budget, now);
          stmts.push(baselineStmt(db, k, base));
        } catch (e) {
          if (e.status === 429) throw e;
          stats.errors++;
          stats.lastError = e.message;
          base = { at: now, ok: false, mode: 'total', pts: [] };
          stmts.push(baselineStmt(db, k, base));
        }
      }
      if (base && base.ok) index = makeIndex(base, indexOpts(sc));
    }

    // Выгодные лоты: сначала удаляем старые записи предмета, потом кладём актуальные.
    const dealEntries = [];
    for (const { l, lk } of keyed) {
      const d = evaluate(index, l);
      if (d && isDeal(d, l, sc, now)) dealEntries.push(entryOf(catalog, region, id, l, region + ':' + id + ':' + lk, d, now));
    }
    if (prev || dealEntries.length) stmts.push(db.prepare('DELETE FROM deals WHERE item_key = ?1').bind(k));
    for (const e of dealEntries) {
      stmts.push(
        db
          .prepare('INSERT OR REPLACE INTO deals (key, item_key, region, item_id, score, end_time, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
          .bind(e.key, k, region, id, e.deal.discount * Math.min(1, e.deal.samples / 10), e.endTime || 0, JSON.stringify(e))
      );
    }
    stats.deals += dealEntries.length;

    // Новые лоты — в ленту (самые свежие последними, чтобы получили больший номер).
    const maxAge = prev ? 3 * 3600 * 1000 : sc.backfillMs;
    const fresh = keyed.filter(({ lk }) => !(prev && prev.seen.has(lk))).sort((a, b) => a.l.startTime - b.l.startTime);
    for (const { l, lk } of fresh) {
      if (l.startTime && now - l.startTime > maxAge) continue;
      const d = evaluate(index, l);
      const e = entryOf(catalog, region, id, l, region + ':' + id + ':' + lk, d && d.discount > 0 ? d : null, now);
      stmts.push(db.prepare('INSERT OR IGNORE INTO feed (key, region, item_id, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(e.key, region, id, JSON.stringify(e), now));
      feedInserts++;
      stats.fresh++;
    }

    if (prev || lots.length) stmts.push(stateStmt(db, k, region, id, lots.length ? 1 : 0, now, keyed.map((x) => x.lk)));
  }

  let retryAfter = 0;
  await Promise.all(
    [...plan.values()].map(async (p) => {
      if (retryAfter) return;
      try {
        await scanOne(p);
      } catch (e) {
        if (e.status === 429) retryAfter = Math.max(retryAfter, e.retryAfter || 15);
        else {
          stats.errors++;
          stats.lastError = e.message;
        }
      }
    })
  );

  // Дальше всё одной транзакцией.
  if (feedInserts) stmts.push(db.prepare('DELETE FROM feed WHERE seq <= (SELECT MAX(seq) FROM feed) - ?1').bind(sc.feedSize));
  stmts.push(db.prepare('DELETE FROM deals WHERE end_time > 0 AND end_time < ?1').bind(Date.now()));
  stmts.push(setMeta(db, 'cursor', newCursor));
  if (wrapped) {
    stmts.push(addMeta(db, 'cycle', 1));
    stmts.push(setMeta(db, 'cycle_ms', started - (Number(meta.cycle_start) || started)));
    stmts.push(setMeta(db, 'cycle_start', started));
  } else if (!meta.cycle_start) stmts.push(setMeta(db, 'cycle_start', started));
  stmts.push(addMeta(db, 'scanned', stats.scanned));
  if (stats.errors) stmts.push(addMeta(db, 'errors', stats.errors));
  if (stats.lastError) stmts.push(setMeta(db, 'last_error', stats.lastError));
  else if (retryAfter) stmts.push(setMeta(db, 'last_error', `Лимит API (429), пауза ${retryAfter} с`));
  else stmts.push(setMeta(db, 'last_error', ''));

  // Следующий тик — не раньше, чем позволит лимит запросов.
  const wait = retryAfter ? retryAfter * 1000 : Math.max(LEASE_FLOOR, Math.round((api.requests * 60000) / config.exbo.ratePerMin));
  stmts.push(setMeta(db, 'lease', Math.max(Date.now() + 300, started + wait)));
  await db.batch(stmts);

  return { ok: true, scanned: stats.scanned, fresh: stats.fresh, deals: stats.deals, requests: api.requests, rateLimited: Boolean(retryAfter) };
}

function stateStmt(db, k, region, id, hot, now, seenKeys) {
  return db
    .prepare('INSERT INTO scan_state (k, region, item_id, hot, last_scan, seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(k) DO UPDATE SET hot = ?4, last_scan = ?5, seen = ?6')
    .bind(k, region, id, hot, now, JSON.stringify(seenKeys));
}

/* ---------------- то, что отдаём в API ---------------- */

export async function getFeed(db, { region = 'all', after = 0, limit = 40 }) {
  const byRegion = region !== 'all';
  const sql = `SELECT seq, data FROM feed WHERE seq > ?1 ${byRegion ? 'AND region = ?3' : ''} ORDER BY seq DESC LIMIT ?2`;
  const st = db.prepare(sql);
  const [rows, top] = await db.batch([byRegion ? st.bind(after, limit, region) : st.bind(after, limit), db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM feed')]);
  return { seq: (top.results[0] || {}).m || 0, items: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), seq: r.seq })) };
}

export async function getDeals(db, { region = 'all', limit = 6 }) {
  const byRegion = region !== 'all';
  const sql = `SELECT data FROM deals WHERE (end_time = 0 OR end_time > ?1) ${byRegion ? 'AND region = ?2' : ''} ORDER BY score DESC LIMIT 80`;
  const st = db.prepare(sql);
  const rows = (await (byRegion ? st.bind(Date.now(), region) : st.bind(Date.now())).all()).results || [];
  const list = rows.map((r) => JSON.parse(r.data));
  const perItem = new Map();
  const out = [];
  for (const e of list) {
    const n = perItem.get(e.itemId) || 0;
    if (n >= 2) continue; // не больше двух лотов одного предмета
    perItem.set(e.itemId, n + 1);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

export async function getStatus(db, { config, catalog }) {
  const [m, f, d] = await db.batch([
    db.prepare("SELECT k, v FROM meta WHERE k IN ('cursor','cycle','cycle_ms','scanned','errors','last_error')"),
    db.prepare('SELECT COUNT(*) AS n FROM feed'),
    db.prepare('SELECT COUNT(*) AS n FROM deals WHERE end_time = 0 OR end_time > ?1').bind(Date.now())
  ]);
  const meta = Object.fromEntries((m.results || []).map((r) => [r.k, r.v]));
  const total = config.regions.length * catalog.items.length;
  return {
    mode: config.demo ? 'demo' : 'live',
    demoReason: config.demoReason,
    regions: config.regions,
    items: catalog.items.length,
    cycle: Number(meta.cycle) || 0,
    progress: total ? Math.min(1, (Number(meta.cursor) || 0) / total) : 0,
    lastCycleSec: Math.round((Number(meta.cycle_ms) || 0) / 1000),
    scanned: Number(meta.scanned) || 0,
    errors: Number(meta.errors) || 0,
    lastError: meta.last_error || '',
    feed: f.results[0].n,
    deals: d.results[0].n
  };
}

/** Страница предмета: живые лоты + опорные цены по качеству и заточке + график продаж. */
export async function itemDetail({ db, api, config, catalog, region, id }) {
  const item = catalog.byId.get(id);
  if (!item) return null;
  const sc = config.scanner;
  const k = region + ':' + id;
  const now = Date.now();

  const [lotsRes, row] = await Promise.all([api.lots(region, id, { limit: 200, sort: 'buyout_price', order: 'asc' }), db.prepare('SELECT at, ok, data FROM baselines WHERE k = ?1').bind(k).first()]);
  let base = row ? parseBaseline(row) : null;
  if (!(base && base.ok && now - base.at < BASELINE_TTL)) {
    try {
      base = await fetchBaseline(api, sc, region, id, lotsRes.lots, { history: 3 }, now);
      await baselineStmt(db, k, base).run();
    } catch (e) {
      if (e.status === 429) throw e;
      base = null;
    }
  }
  const index = base && base.ok ? makeIndex(base, indexOpts(sc)) : null;

  // Лоты без выкупа (только ставка) сортировка может отдать первыми — переносим в конец.
  const lots = lotsRes.lots.slice().sort((a, b) => (a.buyoutPrice || Infinity) / a.amount - (b.buyoutPrice || Infinity) / b.amount);
  const entries = lots.map((l) => {
    const d = evaluate(index, l);
    const e = entryOf(catalog, region, id, l, k + ':' + lotKey(l), null, now);
    e.discount = d ? d.discount : null;
    e.ref = d ? { median: Math.round(d.median), samples: d.samples, basis: d.basis } : null;
    return e;
  });

  let stats = null;
  let history = [];
  if (base && base.pts.length) {
    const all = base.pts.map((p) => p[1]).sort((a, b) => a - b);
    stats = { median: Math.round(median(all)), p25: Math.round(quantile(all, 0.25)), samples: all.length, lastSale: Math.max(...base.pts.map((p) => p[0] || 0)) };
    history = base.pts
      .filter((p) => p[0])
      .sort((a, b) => a[0] - b[0])
      .slice(-150)
      .map((p) => [p[0], Math.round(p[1]), p[2], p[3]]);
  }
  return {
    item: { id, name: item.name, icon: item.icon },
    region,
    total: lotsRes.total,
    lots: entries,
    stats,
    hasQuality: Boolean(index && index.hasQuality),
    groups: index ? index.summary() : [],
    history
  };
}
