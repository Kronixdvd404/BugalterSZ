import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseline, makeIndex, evaluate, isDeal, trimOutliers } from '../src/deals.js';

const OPTS = { minSamples: 5, ptnWindow: 2 };
const SC = { dealMin: 0.15, dealMinSavings: 1000 };
const NOW = 1_800_000_000_000;

// Цена артефакта зависит от качества и заточки: чем выше, тем дороже.
const price = (q, p) => 100_000 * [1, 1.4, 2, 3, 5, 8][q] * (1 + 0.1 * p);
const sale = (q, p, k = 1) => ({ amount: 1, price: Math.round(price(q, p) * k), time: NOW - 1000, qlt: q, ptn: p });
const lot = (q, p, buyout) => ({ amount: 1, buyoutPrice: Math.round(buyout), currentPrice: 1, startPrice: 1, startTime: NOW - 1000, endTime: NOW + 3600_000, qlt: q, ptn: p });

function indexFor(sales) {
  return makeIndex(buildBaseline(sales, [], { now: NOW }), OPTS);
}
const many = (q, p, n, k = 1) => Array.from({ length: n }, (_, i) => sale(q, p, k * (1 + (i % 3) * 0.01)));

test('качество: лот редкого артефакта сравнивается с редкими, а не с обычными', () => {
  const idx = indexFor([...many(0, 0, 20), ...many(3, 0, 8)]);
  // Цена 250 000 — это дёшево для обычного (~100 000)? Нет, дорого. А для редкого (~300 000) — выгодно.
  const d = evaluate(idx, lot(3, 0, 250_000));
  assert.ok(d && d.basis.qlt === 3);
  assert.ok(Math.abs(d.median - 300_000) < 5000);
  assert.ok(isDeal(d, lot(3, 0, 250_000), SC, NOW));
  // Если бы сравнивали со всеми продажами предмета, медиана была бы ~100 000 и лот выглядел бы переплатой.
});

test('заточка: +10 с ценой уровня +0 — выгодный лот, а +0 за ту же цену — нет', () => {
  const idx = indexFor([...many(2, 0, 8), ...many(2, 10, 8)]);
  const cheapForPlus10 = price(2, 0) * 1.0; // продают +10 по цене +0
  const d10 = evaluate(idx, lot(2, 10, cheapForPlus10));
  assert.ok(d10.discount > 0.4, 'для +10 это сильная скидка');
  assert.equal(d10.basis.ptn, 10);
  const d0 = evaluate(idx, lot(2, 0, cheapForPlus10));
  assert.ok(Math.abs(d0.discount) < 0.05, 'для +0 это обычная цена');
  assert.ok(!isDeal(d0, lot(2, 0, cheapForPlus10), SC, NOW));
});

test('мало точных продаж: окно расширяется только вниз по заточке', () => {
  // +5: 2 продажи, +4: 2, +3: 3, +6: 20 штук (они не должны попадать в сравнение для +5)
  const idx = indexFor([...many(1, 5, 2), ...many(1, 4, 2), ...many(1, 3, 3), ...many(1, 6, 20, 5)]);
  const d = evaluate(idx, lot(1, 5, price(1, 5) * 0.6));
  assert.ok(d, 'медиану можно построить по +3..+5');
  assert.equal(d.basis.exact, false);
  assert.equal(d.basis.ptnFrom, 3);
  assert.ok(d.median < price(1, 6), 'продажи +6 не завышают медиану');
});

test('мало продаж даже в окне — лот не оценивается', () => {
  const idx = indexFor([...many(4, 0, 30), ...many(4, 12, 2)]);
  assert.equal(evaluate(idx, lot(4, 12, 1000)), null);
  assert.equal(evaluate(idx, lot(4, 15, 1000)), null);
});

test('у лота нет качества, а в продажах есть — сравнивать нельзя', () => {
  const idx = indexFor(many(2, 0, 10));
  assert.equal(evaluate(idx, { ...lot(null, null, 10_000) }), null);
});

test('предметы без качества сравниваются по общей медиане', () => {
  const sales = Array.from({ length: 10 }, (_, i) => ({ amount: 1, price: 3000 + i * 10, time: NOW - 1000, qlt: null, ptn: null }));
  const idx = indexFor(sales);
  const d = evaluate(idx, lot(null, null, 2000));
  assert.ok(d.discount > 0.3);
  assert.ok(isDeal(d, lot(null, null, 2000), SC, NOW));
});

test('слишком дешёвые лоты (меньше 10% медианы) не считаются выгодой', () => {
  const idx = indexFor(many(0, 0, 10));
  const l = lot(0, 0, 500);
  assert.ok(!isDeal(evaluate(idx, l), l, SC, NOW));
});

test('цена за штуку: стопки сравниваются поштучно', () => {
  const sales = Array.from({ length: 10 }, () => ({ amount: 100, price: 5000, time: NOW - 1000, qlt: null, ptn: null })); // 50 за шт. (весь лот)
  const base = buildBaseline(sales, [], { now: NOW, forcedMode: 'total' });
  const idx = makeIndex(base, OPTS);
  const d = evaluate(idx, { amount: 200, buyoutPrice: 6000, currentPrice: 1, startPrice: 1, startTime: NOW, endTime: 0, qlt: null, ptn: null });
  assert.ok(Math.abs(d.median - 50) < 1e-9);
  assert.ok(d.discount > 0.35 && d.discount < 0.45); // 30 за шт. против 50
});

test('если в истории нет данных о заточке, заточенные лоты не оцениваются', () => {
  const sales = Array.from({ length: 10 }, () => ({ amount: 1, price: 100_000, time: NOW - 1000, qlt: 2, ptn: null }));
  const idx = indexFor(sales);
  assert.equal(evaluate(idx, lot(2, 7, 50_000)), null);
  assert.ok(evaluate(idx, lot(2, 0, 50_000)));
});

test('оверпрайс и лоупрайс в истории не сдвигают медиану', () => {
  // Нормальные продажи ~100 000, плюс три «космических» (оверпрайс) и две заниженные по ошибке (лоупрайс).
  const sales = [...many(2, 0, 10, 0.5), ...[10, 12, 15].map((k) => sale(2, 0, k)), ...[0.01, 0.02].map((k) => sale(2, 0, k))];
  const idx = indexFor(sales);
  const d = evaluate(idx, lot(2, 0, price(2, 0) * 0.6));
  assert.ok(d);
  const normal = price(2, 0) * 0.5;
  assert.ok(Math.abs(d.median - normal) / normal < 0.05, 'медиана около обычной цены: ' + d.median);
  assert.equal(d.samples, 10, 'выбросы не учитываются в выборке');
  // Лот на 40% ниже чистой медианы выгоден.
  assert.ok(isDeal(evaluate(idx, lot(2, 0, normal * 0.6)), lot(2, 0, normal * 0.6), SC, NOW));
});

test('trimOutliers: на малой выборке и при одинаковых ценах ничего не режет', () => {
  assert.deepEqual(trimOutliers([1, 2, 3, 1000]), [1, 2, 3, 1000]);
  const same = [5, 5, 5, 5, 5, 5, 5, 5, 5, 900];
  assert.deepEqual(trimOutliers(same), same);
  assert.deepEqual(trimOutliers([1, 100, 101, 102, 103, 104, 105, 106, 107, 5000]), [100, 101, 102, 103, 104, 105, 106, 107]);
});
