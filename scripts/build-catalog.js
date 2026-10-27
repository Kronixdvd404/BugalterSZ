/*
 * Собирает public/catalog.json — компактный каталог предметов из публичной базы EXBO
 * (https://github.com/EXBO-Studio/stalcraft-database). Запускается при сборке: `npm run build`.
 * Формат: [[id, название, путь к иконке, цвет], ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'catalog.json');
const base = (process.env.ICON_BASE || 'https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru').replace(/\/+$/, '');

try {
  const r = await fetch(base + '/listing.json', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const raw = await r.json();
  const items = [];
  for (const e of raw) {
    const id = path.posix.basename(String(e.data || ''), '.json');
    if (!id) continue;
    const lines = (e.name && e.name.lines) || {};
    // в listing.json путь к иконке бывает с префиксом реалма (/ru/..., /global/...), он уже есть в base
    const icon = e.icon ? String(e.icon).replace(/^\/(?:ru|global)\//, '/') : '';
    items.push([id, lines.ru || lines.en || id, icon, e.color || '']);
  }
  if (!items.length) throw new Error('каталог пуст');
  fs.writeFileSync(out, JSON.stringify(items));
  console.log(`[catalog] предметов: ${items.length}, ${(fs.statSync(out).size / 1024).toFixed(0)} КБ`);
} catch (e) {
  if (fs.existsSync(out)) {
    console.warn('[catalog] не удалось обновить (' + e.message + '), оставляю прежний public/catalog.json');
  } else {
    console.error('[catalog] не удалось скачать каталог предметов: ' + e.message);
    console.error('Нужен доступ к ' + base + '/listing.json. Без него живой режим не заработает (демо-режим от каталога не зависит).');
    process.exit(1);
  }
}
