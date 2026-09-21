import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AmountError,
  format6,
  formatNative18,
  formatNative18Ceil6,
  formatNative18Exact,
  fromNative18,
  parseAmount6,
  toNative18,
} from '../src/index.js';

describe('parseAmount6', () => {
  it.each([
    ['125.50', 125_500_000n],
    ['40', 40_000_000n],
    ['0.000001', 1n],
    ['1000000', 1_000_000_000_000n],
    ['007.10', 7_100_000n],
    [' 12.5 ', 12_500_000n],
    ['12.', 12_000_000n],
    ['.5', 500_000n],
  ])('parses %s → %s', (input, expected) => {
    expect(parseAmount6(input)).toBe(expected);
  });

  it.each([
    ['0', 'zero'],
    ['0.000000', 'zero'],
    ['-1', 'negative'],
    ['1e6', 'scientific'],
    ['1,000', 'comma'],
    ['0.0000001', '7 decimals'],
    ['abc', 'letters'],
    ['', 'empty'],
    ['1.2.3', 'two dots'],
    ['+5', 'plus sign'],
    ['0x10', 'hex'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['１２', 'full-width digits'],
    ['1_000', 'underscore'],
    ['5 USDC', 'suffix'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseAmount6(input)).toThrow(AmountError);
  });

  it('rejects amounts above uint256 range safely', () => {
    expect(() => parseAmount6(`1${'0'.repeat(80)}`)).toThrow(AmountError);
  });
});

describe('conversions', () => {
  it('toNative18 scales by 1e12 and fromNative18 reports dust', () => {
    expect(toNative18(1n)).toBe(1_000_000_000_000n);
    expect(fromNative18(1_000_000_000_000n)).toEqual({ amount6: 1n, dust: 0n });
    expect(fromNative18(1_000_000_000_001n)).toEqual({ amount6: 1n, dust: 1n });
    expect(fromNative18(999_999_999_999n)).toEqual({ amount6: 0n, dust: 999_999_999_999n });
  });

  it('round-trips amount6 → native18 → amount6 with zero dust (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 96n }), (a) => {
        const r = fromNative18(toNative18(a));
        return r.amount6 === a && r.dust === 0n;
      }),
    );
  });

  it('never drops sub-6dp dust (property)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 128n }), (n) => {
        const { amount6, dust } = fromNative18(n);
        return toNative18(amount6) + dust === n && dust < 1_000_000_000_000n;
      }),
    );
  });
});

describe('formatting', () => {
  it.each([
    [125_500_000n, '125.50'],
    [40_000_000n, '40.00'],
    [1n, '0.000001'],
    [0n, '0.00'],
    [1_234_567n, '1.234567'],
    [1_000_000_000_000n, '1000000.00'],
    [10_500_000n, '10.50'],
  ])('format6(%s) = %s', (a, s) => {
    expect(format6(a)).toBe(s);
  });

  it('format6(parseAmount6(x)) is canonical and re-parses to the same value (property)', () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 2n ** 80n }), (a) => parseAmount6(format6(a)) === a));
  });

  it('formatNative18Exact is a plain decimal that keeps every native unit (spreadsheet-summable)', () => {
    expect(formatNative18Exact(7_020_910_000_000_000n)).toBe('0.00702091');
    expect(formatNative18Exact(1_000_000_000_001n)).toBe('0.000001000000000001');
    expect(formatNative18Exact(7n)).toBe('0.000000000000000007');
    expect(formatNative18Exact(0n)).toBe('0.00');
    expect(formatNative18Exact(5n * 10n ** 18n)).toBe('5.00');
    expect(formatNative18Exact(-1_500_000_000_000_000_000n)).toBe('-1.50');
  });
  it('formatNative18Ceil6 rounds an estimate up to 6 dp, never down', () => {
    expect(formatNative18Ceil6(43_541_032_500_000_000n)).toBe('0.043542');
    expect(formatNative18Ceil6(43_541_000_000_000_000n)).toBe('0.043541');
    expect(formatNative18Ceil6(0n)).toBe('0.00');
  });
  it('formatNative18 shows 6 dp and flags dust', () => {
    expect(formatNative18(420_000_000_000_000n)).toBe('0.00042');
    expect(formatNative18(1_000_000_000_001n)).toBe('0.000001 (+1 dust)');
    expect(formatNative18(0n)).toBe('0.00');
  });
});
