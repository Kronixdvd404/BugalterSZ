export class ApiError extends Error {
  constructor(msg, status, retryAfter = 0) {
    super(msg);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const optNum = (v) => (v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : null);

export function normalizeLot(l) {
  const add = l.additional || {};
  return {
    amount: Math.max(1, num(l.amount) || 1),
    startPrice: num(l.startPrice),
    currentPrice: num(l.currentPrice) || num(l.startPrice),
    buyoutPrice: num(l.buyoutPrice),
    startTime: l.startTime ? Date.parse(l.startTime) || 0 : 0,
    endTime: l.endTime ? Date.parse(l.endTime) || 0 : 0,
    qlt: optNum(add.qlt), // качество: 0 обычный … 5 легендарный
    ptn: optNum(add.ptn) // заточка: +0 … +15
  };
}

export function normalizeSale(p) {
  const add = p.additional || {};
  return {
    amount: Math.max(1, num(p.amount) || 1),
    price: num(p.price),
    time: p.time ? Date.parse(p.time) || 0 : 0,
    qlt: optNum(add.qlt),
    ptn: optNum(add.ptn)
  };
}

let tokenMem = { token: '', exp: 0 };

export class ExboApi {
  constructor(config, db) {
    this.cfg = config.exbo;
    this.db = db;
    this.requests = 0; // сколько запросов к EXBO сделано за этот тик
  }

  async _getToken(force) {
    if (this.cfg.token) return this.cfg.token;
    const now = Date.now();
    if (!force && tokenMem.token && now < tokenMem.exp - 60000) return tokenMem.token;
    if (!force) {
      // токен мог получить другой экземпляр воркера — берём из базы, чтобы не просить новый
      const row = await this.db.prepare("SELECT v FROM meta WHERE k = 'exbo_token'").first();
      if (row) {
        try {
          const t = JSON.parse(row.v);
          if (t.token && now < t.exp - 60000) {
            tokenMem = t;
            return t.token;
          }
        } catch (_) {}
      }
    }
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: '' });
    const r = await fetch(this.cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (!r.ok) throw new ApiError(`OAuth: ${r.status} ${(await r.text()).slice(0, 160)}`, r.status);
    const j = await r.json();
    tokenMem = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    await this.db.prepare("INSERT INTO meta (k, v) VALUES ('exbo_token', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1").bind(JSON.stringify(tokenMem)).run();
    return tokenMem.token;
  }

  async _request(pathname, query, attempt = 0) {
    const url = new URL(this.cfg.baseUrl + pathname);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const token = await this._getToken(false);
    this.requests++;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (res.status === 429) {
      throw new ApiError('Лимит запросов EXBO API (429)', 429, Math.min(120, Number(res.headers.get('retry-after')) || 15));
    }
    if (res.status === 401 && attempt < 1 && !this.cfg.token) {
      await this._getToken(true);
      return this._request(pathname, query, attempt + 1);
    }
    if (!res.ok) throw new ApiError(`API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`, res.status);
    return res.json();
  }

  /** Активные лоты предмета. sort: time_created | time_left | current_price | buyout_price */
  async lots(region, item, { limit = 200, offset = 0, sort = 'time_created', order = 'desc' } = {}) {
    const j = await this._request(`/${region}/auction/${encodeURIComponent(item)}/lots`, { limit, offset, sort, order, additional: 'true' });
    return { total: num(j.total), lots: (j.lots || []).map(normalizeLot) };
  }

  /** История проданных лотов (новые первыми). */
  async history(region, item, { limit = 200, offset = 0 } = {}) {
    const j = await this._request(`/${region}/auction/${encodeURIComponent(item)}/history`, { limit, offset, additional: 'true' });
    return { total: num(j.total), sales: (j.prices || []).map(normalizeSale) };
  }
}
