import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePricing } from '../src/lib/pricing.js';
import { DEFAULT_SETTINGS, feeTotal } from '../src/config/defaults.js';
import { money, parseMoney, firstNameOf, nameKey } from '../src/lib/format.js';

const fees = DEFAULT_SETTINGS.fees;

test('fees total $1,331 (999 + 299 + 33)', () => {
  assert.equal(feeTotal(fees), 1331);
});

test('special = asking − discount; with fees = special + 1331', () => {
  const p = computePricing({ asking: 32995, discount: 1500, fees });
  assert.equal(p.special, 31495);
  assert.equal(p.withFees, 32826);
});

test('zero discount is allowed', () => {
  assert.equal(computePricing({ asking: 20000, discount: 0, fees }).withFees, 21331);
});

test('rejects missing asking, negative discount, discount >= asking', () => {
  assert.throws(() => computePricing({ asking: null, discount: 500, fees }));
  assert.throws(() => computePricing({ asking: 20000, discount: -1, fees }));
  assert.throws(() => computePricing({ asking: 20000, discount: 20000, fees }));
});

test('money formatting and parsing', () => {
  assert.equal(money(32826), '$32,826');
  assert.equal(money(-1500), '-$1,500');
  assert.equal(parseMoney('$32,995'), 32995);
  assert.equal(parseMoney(''), null);
});

test('first names and name keys', () => {
  assert.equal(firstNameOf('Smith, JANE'), 'Jane');
  assert.equal(firstNameOf('maria lopez'), 'Maria');
  assert.equal(nameKey('Clemons, Rick'), nameKey('Rick Clemons'));
});
