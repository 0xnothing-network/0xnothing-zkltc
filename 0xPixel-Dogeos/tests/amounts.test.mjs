import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDoge, formatDoge} from '../src/lib/amounts.mjs';

test('DOGE amounts preserve the exact value from one wei to uint256', () => {
  assert.equal(parseDoge('0.000000000000000001'), 1n);
  assert.equal(formatDoge(1n), '0.000000000000000001');
  const maximum = (1n << 256n) - 1n;
  const plain = formatDoge(maximum).replaceAll(',', '');
  assert.equal(parseDoge(plain), maximum);
  assert.equal(formatDoge(123456789012345678901234567n), '123,456,789.012345678901234567');
  assert.equal(formatDoge(0n), '0');
});

test('Prices reject silent rounding, exponent syntax, zero and uint256 overflow', () => {
  for (const value of ['0', '0.0000000000000000001', '1.0000000000000000001', '1e3', '-1', '+1', 'NaN', 'Infinity', '0x123', '', '1,000', '1.2.3', '9'.repeat(129)]) {
    assert.throws(() => parseDoge(value), Error, value);
  }
  assert.throws(() => parseDoge(formatDoge(1n << 256n).replaceAll(',', '')), /range/);
  assert.equal(parseDoge(' 001.2300 '), 1230000000000000000n);
  assert.equal(parseDoge('.1'), 100000000000000000n);
  assert.equal(parseDoge('1.'), 1000000000000000000n);
});
