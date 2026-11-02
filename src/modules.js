/*
 * Оружейные модули. Предмет «Оружейный модуль» в каталоге один, а модулей внутри него много и они сильно
 * отличаются по цене: «Снайпер», «Пробойник», «Слайдер» и так далее. Поэтому лоты и продажи модулей сравниваются
 * по названию модуля в кавычках, а уже потом по качеству.
 */

const QUOTED = /[«"“]([^«»"“”]{1,40})[»"”]/;

// Поля, в которых модуль может называться без кавычек.
const NAME_KEYS = ['module', 'module_name', 'modulename', 'wpn_mod', 'wpn_mod_name', 'mod_name', 'name'];

/** Предметы, у которых есть названия модулей: категория weapon_modules/*, либо id из MODULE_ITEMS. */
export function isModuleItem(item, extraIds = []) {
  if (!item) return false;
  if (extraIds.includes(item.id)) return true;
  return String(item.category || '').startsWith('weapon_modules/');
}

function fromString(s) {
  const m = QUOTED.exec(s);
  return m ? m[1].trim() : '';
}

function walk(v, depth, out) {
  if (depth > 4 || v === null || v === undefined) return;
  if (typeof v === 'string') {
    const q = fromString(v);
    if (q) out.push(q);
  } else if (Array.isArray(v)) {
    for (const x of v) walk(x, depth + 1, out);
  } else if (typeof v === 'object') {
    // переводы вида {lines: {ru: '«Снайпер»'}}: берём русский текст
    if (v.lines && typeof v.lines.ru === 'string') walk(v.lines.ru, depth + 1, out);
    for (const x of Object.values(v)) walk(x, depth + 1, out);
  }
}

/**
 * Достаёт название модуля из поля additional лота или продажи. null, если названия нет.
 * Сначала ищем текст в кавычках где угодно в additional, потом (запасной путь) простые строковые поля.
 */
export function moduleName(add) {
  if (!add || typeof add !== 'object') return null;
  const found = [];
  walk(add, 0, found);
  if (found.length) return found[0];
  for (const k of NAME_KEYS) {
    const v = add[k];
    if (typeof v === 'string' && v.trim() && v.trim().length <= 40) return v.trim();
  }
  return null;
}

/** Сортировка по названию модуля, затем по качеству и заточке. */
export const byModule = (a, b) => String(a.mod || '').localeCompare(String(b.mod || ''), 'ru') || (a.qlt ?? -1) - (b.qlt ?? -1) || (a.ptn ?? 0) - (b.ptn ?? 0);
