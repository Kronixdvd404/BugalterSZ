/*
 * Чёрный список предметов. Такие предметы не сканируются и не попадают в «Новые лоты» и «Выгодные лоты»
 * на главной странице, но по-прежнему находятся поиском, и страница предмета работает как обычно.
 *
 * Правки вносить здесь (или переменными окружения, см. ниже). Категории совпадают с папками каталога EXBO:
 *   misc          материалы и «части» (Электродвигатель, Гипс, Часть HK XM8S #2 …)
 *   supply/food   еда
 *   supply/drink  напитки
 *   other         косметика: камуфляжи и покрасы («Сверхзвуковой», «Леший», Камуфляж «Бутан» …)
 * Остальные категории: bullet, grenade, supply/medicine, containers, backpacks, attachment/*, weapon/*, armor/*, artefact/* …
 */
export const DEFAULT_BLACKLIST = {
  categories: ['misc', 'supply/food', 'supply/drink', 'other'],
  keepCategories: ['other/skins'], // исключения из categories: эти категории остаются в ленте
  ids: [], // отдельные предметы по id (id виден в адресе предмета в базе EXBO)
  names: [] // фрагменты названий, без учёта регистра
};

const list = (v) =>
  String(v === undefined || v === null ? '' : v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const inCategory = (cat, rule) => cat === rule || cat.startsWith(rule + '/');

/**
 * Возвращает функцию item => true, если предмет в чёрном списке.
 * Переменные окружения: BLACKLIST_OFF=1 (выключить), BLACKLIST_CATEGORIES (заменить список категорий),
 * BLACKLIST_IDS (добавить id), BLACKLIST_NAMES (добавить фрагменты названий). Значения через запятую.
 */
export function makeBlacklist(env = {}) {
  if (['1', 'true', 'yes'].includes(String(env.BLACKLIST_OFF || '').toLowerCase())) return () => false;
  const cats = env.BLACKLIST_CATEGORIES !== undefined ? list(env.BLACKLIST_CATEGORIES) : DEFAULT_BLACKLIST.categories;
  const keep = DEFAULT_BLACKLIST.keepCategories;
  const ids = new Set([...DEFAULT_BLACKLIST.ids, ...list(env.BLACKLIST_IDS)]);
  const names = [...DEFAULT_BLACKLIST.names, ...list(env.BLACKLIST_NAMES)].map((s) => s.toLowerCase());
  return (item) => {
    if (!item) return false;
    if (ids.has(item.id)) return true;
    const cat = item.category || '';
    if (cat && cats.some((c) => inCategory(cat, c)) && !keep.some((c) => inCategory(cat, c))) return true;
    const low = String(item.name || '').toLowerCase();
    return names.some((n) => low.includes(n));
  };
}
