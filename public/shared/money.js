/*
 * Разбор и форматирование сумм. Один файл для сервера и браузера.
 *
 * Понимает: 10000, 10 000, 10к, 10k, 1.5кк, 1,5 млн, 2.5м, 10.000, 10,000,
 * 3 млрд, 500 руб, 15 000₽, +5к (знак игнорируется: тип операции выбирают кнопкой).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Money = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX = 1e15;
  const NBSP = ' ';

  const SUFFIXES = [
    [/^(?:kkk|ккк|млрд|bn|b|б)$/, 1e9],
    [/^(?:kk|кк|mm|млн|mln|mil|m|м)$/, 1e6],
    [/^(?:k|к|тыс|т|th)$/, 1e3],
  ];

  function suffixMultiplier(s) {
    if (!s) return 1;
    for (const [re, mult] of SUFFIXES) if (re.test(s)) return mult;
    return null;
  }

  // Число без суффикса: определяем, где десятичный разделитель, а где разряды.
  function parseNumber(num, hasSuffix) {
    const dots = (num.match(/\./g) || []).length;
    const commas = (num.match(/,/g) || []).length;

    if (dots && commas) {
      // "1.234,5" или "1,234.5": последний разделитель десятичный
      const dec = Math.max(num.lastIndexOf('.'), num.lastIndexOf(','));
      const intPart = num.slice(0, dec).replace(/[.,]/g, '');
      return Number(intPart + '.' + num.slice(dec + 1));
    }
    if (!dots && !commas) return Number(num);

    const sep = dots ? '.' : ',';
    const parts = num.split(sep);
    if (parts.length > 2) {
      // "1.000.000": разряды, все группы после первой по 3 цифры
      if (!parts.slice(1).every((p) => p.length === 3)) return NaN;
      return Number(parts.join(''));
    }
    const [a, b] = parts;
    // "10.000" / "10,000" без суффикса читаем как 10 тысяч, а "1.5к" как 1.5
    if (!hasSuffix && a !== '' && a.length <= 3 && b.length === 3) return Number(a + b);
    return Number((a || '0') + '.' + b);
  }

  /**
   * Возвращает { ok: true, value } или { ok: false, error }.
   * value всегда целое и неотрицательное.
   */
  function parseMoney(input) {
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return { ok: false, error: 'Не понял сумму' };
      const v = Math.round(Math.abs(input));
      return v > MAX ? { ok: false, error: 'Слишком большая сумма' } : { ok: true, value: v };
    }
    if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'Введите сумму' };

    const s = input
      .toLowerCase()
      .replace(/[\s  _'’`]/g, '')
      .replace(/^[+\-−–]/, '')
      .replace(/(?:рублей|рубля|руб\.?|р\.?|₽|rub)$/, '');
    const m = s.match(/^(\d[\d.,]*|[.,]\d+)([a-zа-яё]*)$/);
    if (!m) return { ok: false, error: 'Не понял сумму. Примеры: 10к, 1.5кк, 10000' };

    const mult = suffixMultiplier(m[2]);
    if (mult === null) return { ok: false, error: 'Не понял «' + m[2] + '». Используйте к, кк или ккк' };

    const n = parseNumber(m[1], m[2] !== '');
    if (!Number.isFinite(n)) return { ok: false, error: 'Не понял сумму. Примеры: 10к, 1.5кк, 10000' };

    const value = Math.round(n * mult);
    if (value > MAX) return { ok: false, error: 'Слишком большая сумма' };
    return { ok: true, value };
  }

  /** 1234567 → "1 234 567" (неразрывные пробелы), отрицательные со знаком «−» */
  function formatMoney(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '−' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  }

  /** 1500 → "+1 500", -1500 → "−1 500", 0 → "0" */
  function formatSigned(n) {
    const v = Math.round(Number(n) || 0);
    return v > 0 ? '+' + formatMoney(v) : formatMoney(v);
  }

  /** 1500000 → "1,5кк", 25000 → "25к", 950 → "950" */
  function formatShort(n) {
    const v = Math.abs(Math.round(Number(n) || 0));
    const sign = n < 0 ? '−' : '';
    const fmt = (x, suf) => sign + String(Math.round(x * 10) / 10).replace('.', ',') + suf;
    if (v >= 1e9) return fmt(v / 1e9, 'ккк');
    if (v >= 1e6) return fmt(v / 1e6, 'кк');
    if (v >= 1e4) return fmt(v / 1e3, 'к');
    return sign + String(v);
  }

  return { parseMoney, formatMoney, formatSigned, formatShort, MAX };
});
