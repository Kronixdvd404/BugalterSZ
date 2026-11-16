/*
 * Защита от «двойников» ников. Скелет ника: нижний регистр, без диакритики и разделителей (_ . -),
 * похожие кириллические буквы заменены латинскими (а → a, о → o, с → c …), 0 → o, 1 → l, i → l.
 * Два ника с одинаковым скелетом считаются одним: «Kronix404» и «Кroniх404» (с русскими К и х) не уживутся.
 */
const MAP = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'l',
  '0': 'o', '1': 'l', i: 'l'
};

export function nickSkeleton(nick) {
  const base = String(nick).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_.\-]/g, '');
  return [...base].map((c) => MAP[c] ?? c).join('');
}

// Служебные имена и бренды. Ники владельца сюда не входят: после регистрации они защищаются автоматически
// (скрипт npm run db:turso заносит скелеты всех существующих ников).
const RESERVED = ['admin', 'administrator', 'administration', 'moderator', 'mod', 'root', 'system', 'support', 'staff', 'owner', 'official', 'helpdesk', 'bugaltersz', 'bugalter', 'exbo', 'stalcraft', 'stalzone', 'null', 'undefined'];
const RESERVED_SK = new Set(RESERVED.map(nickSkeleton));

export const isReservedNick = (nick) => RESERVED_SK.has(nickSkeleton(nick));
