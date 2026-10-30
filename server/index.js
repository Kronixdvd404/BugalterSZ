/*
 * Собственный сервер BugalterSZ (для Oracle Cloud и любого другого VPS).
 * Раздаёт сайт из public/, обрабатывает /api/* теми же маршрутами, что и Cloudflare Functions,
 * хранит данные в файле SQLite и сам крутит сканер аукциона в фоне (открытые вкладки для этого больше не нужны).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch (_) {
  /* файла .env нет — берём переменные окружения как есть */
}

const { handle, backgroundTick } = await import('../src/app.js');
const { openDatabase } = await import('./db.js');
const { sleep } = await import('../src/util.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
const PUBLIC_DIR = path.join(root, 'public');
const DATA_DIR = path.resolve(root, process.env.DATA_DIR || 'data');
const MAX_BODY = 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = openDatabase(path.join(DATA_DIR, 'bugalter.db'), fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'));

// Правила заголовков берём из public/_headers, чтобы они совпадали с Cloudflare-версией.
function parseHeaders() {
  const rules = [];
  let cur = null;
  let text = '';
  try {
    text = fs.readFileSync(path.join(PUBLIC_DIR, '_headers'), 'utf8');
  } catch (_) {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      cur = { pattern: line.trim(), headers: {} };
      rules.push(cur);
    } else if (cur) {
      const i = line.indexOf(':');
      if (i > 0) cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}
const headerRules = parseHeaders();
const headersFor = (pathname) => {
  const out = {};
  for (const r of headerRules) {
    if (r.pattern === '/*' || r.pattern === pathname) Object.assign(out, r.headers);
  }
  return out;
};

const env = {
  ...process.env,
  DB: db,
  BACKGROUND_SCAN: process.env.BACKGROUND_SCAN === undefined ? '1' : process.env.BACKGROUND_SCAN,
  ASSETS: {
    async fetch(url) {
      const file = safePath(new URL(url).pathname);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(file), { headers: { 'Content-Type': 'application/json' } });
    }
  }
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function safePath(pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }
  if (p.includes('\0')) return null;
  const file = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return null;
  if (path.basename(file) === '_headers') return null;
  return file;
}

function serveStatic(req, res, pathname) {
  const file = safePath(pathname);
  let st = null;
  try {
    st = file && fs.statSync(file);
  } catch (_) {}
  if (!st || !st.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    return res.end('Не найдено');
  }
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
    ...headersFor(pathname)
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveApi(req, res, url) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'cf-connecting-ip') continue; // этот заголовок выставляем сами, клиенту верить нельзя
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0].trim();
  headers.set('cf-connecting-ip', ip);

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const request = new Request(url, { method: req.method, headers, body: hasBody ? await readBody(req) : undefined });
  const response = await handle(request, env);
  const out = {};
  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') out[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out['set-cookie'] = cookies;
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  try {
    const proto = TRUST_PROXY && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : 'http';
    const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await serveApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e && e.status === 413 ? 413 : 500;
    if (status === 500) console.error('[server]', e && e.stack ? e.stack : e);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status === 413 ? 'Слишком большой запрос' : 'Внутренняя ошибка сервера' }));
  }
});

// Фоновый сканер: шаг за шагом обходит каталог. Паузы между запросами к EXBO выдерживает сам tick() через «аренду» в базе.
let stopping = false;
async function scannerLoop() {
  let lastMsg = '';
  while (!stopping) {
    let delay = 400;
    try {
      const r = await backgroundTick(env);
      if (r && r.skipped) delay = 800;
      lastMsg = '';
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (msg !== lastMsg) console.error('[scanner]', msg);
      lastMsg = msg;
      delay = 5000;
    }
    await sleep(delay);
  }
}

server.listen(PORT, HOST, () => {
  const demo = !(process.env.EXBO_TOKEN || (process.env.EXBO_CLIENT_ID && process.env.EXBO_CLIENT_SECRET)) || ['1', 'true'].includes(String(process.env.DEMO || '').toLowerCase());
  console.log(`[server] http://${HOST}:${PORT}  база: ${path.join(DATA_DIR, 'bugalter.db')}  режим: ${demo ? 'ДЕМО (нет ключей EXBO)' : 'живой'}`);
  if (env.BACKGROUND_SCAN === '1') {
    console.log('[scanner] фоновый сканер запущен');
    scannerLoop();
  }
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[server] остановка…');
  server.close(() => {
    try {
      db.close();
    } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
