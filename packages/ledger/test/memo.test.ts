import fc from 'fast-check';
import { hexToString, keccak256, stringToHex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  decodeMemoData,
  encodeMemoData,
  linkMemoId,
  MEMO_DATA_MAX_BYTES,
  newRunId,
  payoutMemoId,
} from '../src/index.js';

describe('memo ids', () => {
  it('payoutMemoId is keccak256 of "po:<run>:<row>"', () => {
    expect(payoutMemoId('RUN1', 12)).toBe(keccak256(stringToHex('po:RUN1:12')));
  });
  it('linkMemoId is keccak256 of "pl:<link>"', () => {
    expect(linkMemoId('L1')).toBe(keccak256(stringToHex('pl:L1')));
  });
  it('different rows/runs never collide (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.nat(9999),
        fc.nat(9999),
        (r, a, b) => a === b || payoutMemoId(r, a) !== payoutMemoId(r, b),
      ),
    );
  });
  it('newRunId is 26 chars of Crockford base32 and unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newRunId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('memo data', () => {
  it('encodes compact JSON and decodes back', () => {
    const d = { v: 1 as const, t: 'po' as const, run: 'RUN1', row: 3, ref: 'INV-204' };
    const hex = encodeMemoData(d);
    expect(hexToString(hex)).toBe('{"v":1,"t":"po","run":"RUN1","row":3,"ref":"INV-204"}');
    expect(decodeMemoData(hex)).toEqual(d);
  });
  it('rejects data over 256 bytes', () => {
    // Controller ruling: brief's ref: 'x'.repeat(300) hits the reference-charset check first
    // (references are 1-64 chars), so it throws /reference/, not /256/. Exceed the byte limit
    // with a long run id instead, and keep a separate assertion for the over-length reference.
    expect(() => encodeMemoData({ v: 1, t: 'po', run: 'R'.repeat(300), row: 1, ref: 'x' })).toThrow(/256/);
    expect(() => encodeMemoData({ v: 1, t: 'po', run: 'R', row: 1, ref: 'x'.repeat(300) })).toThrow(
      /reference/,
    );
    expect(MEMO_DATA_MAX_BYTES).toBe(256);
  });
  it('rejects references with disallowed characters (no personal data / free text on-chain)', () => {
    expect(() => encodeMemoData({ v: 1, t: 'po', run: 'R', row: 1, ref: 'alice@example.com' })).toThrow(
      /reference/,
    );
  });
  it('decode returns null for garbage, wrong version, or foreign JSON', () => {
    expect(decodeMemoData('0x')).toBeNull();
    expect(decodeMemoData(stringToHex('not json'))).toBeNull();
    expect(decodeMemoData(stringToHex('{"v":2,"t":"po"}'))).toBeNull();
    expect(decodeMemoData(stringToHex('{"hello":"world"}'))).toBeNull();
    expect(decodeMemoData('0xffff')).toBeNull();
  });
});
