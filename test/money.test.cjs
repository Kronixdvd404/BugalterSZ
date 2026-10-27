const assert = require('assert');
const { parseMoney, formatMoney, formatSigned, formatShort } = require('../public/shared/money.js');

const ok = (input, expected) => {
  const r = parseMoney(input);
  assert.ok(r.ok, `"${input}" должен разбираться, а вернул: ${r.error}`);
  assert.strictEqual(r.value, expected, `"${input}" -> ${r.value}, ждали ${expected}`);
};
const bad = (input) => assert.strictEqual(parseMoney(input).ok, false, `"${input}" должен быть ошибкой`);

ok('10к', 10000);
ok('10k', 10000);
ok('10К', 10000);
ok('10000', 10000);
ok('10 000', 10000);
ok('10.000', 10000);
ok('10,000', 10000);
ok('1.5кк', 1500000);
ok('1,5кк', 1500000);
ok('1.5kk', 1500000);
ok('2кк', 2000000);
ok('2м', 2000000);
ok('2.5млн', 2500000);
ok('1 000 000', 1000000);
ok('1.250.000', 1250000);
ok('0.5ккк', 500000000);
ok('2млрд', 2000000000);
ok('15 000₽', 15000);
ok('15000 руб', 15000);
ok('+5к', 5000);
ok('-5к', 5000);
ok('0', 0);
ok('250', 250);
ok('1.5к', 1500);
ok('  7 к ', 7000);
ok(12345, 12345);

bad('');
bad('abc');
bad('10кккк');
bad('1.2.3к5');
bad('к10');
bad('99999999999999999999');

assert.strictEqual(formatMoney(1234567), '1 234 567');
assert.strictEqual(formatMoney(-1500), '−1 500');
assert.strictEqual(formatSigned(1500), '+1 500');
assert.strictEqual(formatSigned(-1500), '−1 500');
assert.strictEqual(formatSigned(0), '0');
assert.strictEqual(formatShort(1500000), '1,5кк');
assert.strictEqual(formatShort(25000), '25к');
assert.strictEqual(formatShort(950), '950');

console.log('money: все проверки пройдены');
