import fc from 'fast-check';
import { encodeAbiParameters, hexToString, keccak256, stringToHex, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  decodeMemoData,
  decodeMemoText,
  encodeMemoData,
  linkMemoId,
  MEMO_DATA_MAX_BYTES,
  MEMO_TEXT_MAX_CHARS,
  memoReference,
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
    // (references are 1-64 chars), so it throws /reference/, not /256/. run/link are also now
    // charset-checked (max 64 chars), so push past the byte cap with max-length, charset-valid
    // run/link/ref fields plus a large row instead, and keep a separate assertion for the
    // over-length reference.
    expect(() =>
      encodeMemoData({
        v: 1,
        t: 'po',
        run: 'R'.repeat(64),
        row: Number.MAX_SAFE_INTEGER,
        link: 'L'.repeat(64),
        ref: 'F'.repeat(64),
      }),
    ).toThrow(/256/);
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
  it('rejects run/link ids with disallowed characters on encode (defense in depth)', () => {
    expect(() => encodeMemoData({ v: 1, t: 'po', run: 'has space', row: 1 })).toThrow(/run/);
    expect(() => encodeMemoData({ v: 1, t: 'pl', link: 'has space' })).toThrow(/link/);
  });
  it('decode returns null for garbage, wrong version, or foreign JSON', () => {
    expect(decodeMemoData('0x')).toBeNull();
    expect(decodeMemoData(stringToHex('not json'))).toBeNull();
    expect(decodeMemoData(stringToHex('{"v":2,"t":"po"}'))).toBeNull();
    expect(decodeMemoData(stringToHex('{"hello":"world"}'))).toBeNull();
    expect(decodeMemoData('0xffff')).toBeNull();
  });
  it('decode returns null for a wrong-typed row (attacker-controlled bytes must not smuggle types)', () => {
    expect(decodeMemoData(stringToHex('{"v":1,"t":"po","row":"3"}'))).toBeNull();
  });
  it('decode returns null for a ref with a disallowed charset', () => {
    expect(decodeMemoData(stringToHex('{"v":1,"t":"po","ref":"alice@example.com"}'))).toBeNull();
  });
  it('decode returns null for a run id containing a space', () => {
    expect(decodeMemoData(stringToHex('{"v":1,"t":"po","run":"has space"}'))).toBeNull();
  });
  it('decode drops unknown keys rather than passing them through', () => {
    const hex = stringToHex('{"v":1,"t":"po","run":"RUN1","evil":"payload"}');
    expect(decodeMemoData(hex)).toEqual({ v: 1, t: 'po', run: 'RUN1' });
  });
  it('a valid full object round-trips unchanged', () => {
    const d = { v: 1 as const, t: 'po' as const, run: 'RUN1', row: 3, link: 'L1', ref: 'INV-204' };
    expect(decodeMemoData(encodeMemoData(d))).toEqual(d);
  });
});

/** Every character a foreign memo reference may contain: ASCII letters, digits, space and . _ : - / = # @ , + */
const SAFE_TEXT = /^[A-Za-z0-9 ._:\-/=#@,+]*$/;

describe('memo text written by other Arc apps', () => {
  it('reads the reference Arc’s own tutorial writes (stringToHex of plain text)', () => {
    expect(decodeMemoText(stringToHex('order=2026-0001'))).toBe('order=2026-0001');
  });
  it('keeps the whole safe set: letters, digits, space and . _ : - / = # @ , +', () => {
    const all = 'Ab9 ._:-/=#@,+';
    expect(decodeMemoText(stringToHex(all))).toBe(all);
  });
  it('drops markup: a script tag comes back with no markup characters', () => {
    const out = decodeMemoText(stringToHex('<script>alert(1)</script>'));
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/[<>()"'&;]/);
    expect(out).toBe('alert1');
  });
  it('drops markup attributes and quotes, keeps the text around them', () => {
    expect(decodeMemoText(stringToHex('INV-7 <img src=x onerror="steal()"> paid'))).toBe('INV-7 paid');
  });
  it('removes control characters, including NUL, bell, escape, delete and C1 codes', () => {
    expect(decodeMemoText(stringToHex('INV\u0000-\u0007\u001b2026\u007f\u0085\u009b'))).toBe('INV-2026');
  });
  it('removes direction overrides and invisible characters that could disguise a reference', () => {
    expect(decodeMemoText(stringToHex('INV\u202e-1\u200b2\ufeff'))).toBe('INV-12');
  });
  it('turns line breaks and tabs into single spaces and trims the ends', () => {
    expect(decodeMemoText(stringToHex('  order=1\r\n\tpaid   in full \n'))).toBe('order=1 paid in full');
  });
  it('gives null for ABI-encoded numbers and tuples, which are ids, not text', () => {
    for (const n of [12345n, 49n, 65n, 100n, 0x494e56n]) {
      expect(decodeMemoText(encodeAbiParameters([{ type: 'uint256' }], [n]))).toBeNull();
    }
    expect(
      decodeMemoText(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0x494e56n, 0x31n])),
    ).toBeNull();
    // An address or a hash left-padded into a word is binary too.
    expect(
      decodeMemoText(
        encodeAbiParameters([{ type: 'address' }], ['0x0000000000000000000000000000000000000049']),
      ),
    ).toBeNull();
  });
  it('gives null when most of the bytes are control characters', () => {
    expect(decodeMemoText(toHex(new Uint8Array([1, 2, 3, 0x41, 4, 5, 6, 0x42])))).toBeNull();
  });
  it('reads a short text padded to 32 bytes with zeros', () => {
    expect(decodeMemoText(stringToHex('order=1', { size: 32 }))).toBe('order=1');
  });
  it('caps a 200-byte memo at 64 characters', () => {
    const long = 'order=2026-0001/'.repeat(13).slice(0, 200);
    expect(new TextEncoder().encode(long).length).toBe(200);
    const out = decodeMemoText(stringToHex(long));
    expect(out).toBe(long.slice(0, 64));
    expect(out?.length).toBe(64);
    expect(MEMO_TEXT_MAX_CHARS).toBe(64);
  });
  it('never ends on a space after the cap', () => {
    const out = decodeMemoText(stringToHex(`${'a'.repeat(63)} tail`));
    expect(out).toBe('a'.repeat(63));
  });
  it('gives null for an empty memo', () => {
    expect(decodeMemoText('0x')).toBeNull();
  });
  it('gives null for a memo with nothing printable', () => {
    expect(decodeMemoText('0x00000000')).toBeNull();
    expect(decodeMemoText(stringToHex(' \t\r\n '))).toBeNull();
    expect(decodeMemoText(stringToHex('<>()[]{}"\'`;&'))).toBeNull();
    expect(decodeMemoText(stringToHex('<br/>'))).toBeNull();
  });
  it('gives null for binary memos, even when some bytes happen to be letters', () => {
    expect(decodeMemoText('0xffff')).toBeNull();
    expect(decodeMemoText('0xfe41424344ff')).toBeNull();
    // A 32-byte hash used as a memo is binary, not a reference.
    expect(decodeMemoText(keccak256(stringToHex('order=2026-0001')))).toBeNull();
  });
  it('gives null for a Memoline memo: those are read by decodeMemoData, not as free text', () => {
    expect(decodeMemoText(encodeMemoData({ v: 1, t: 'po', run: 'RUN1', row: 3, ref: 'INV-204' }))).toBeNull();
    expect(decodeMemoText(encodeMemoData({ v: 1, t: 'pl', link: 'L1' }))).toBeNull();
  });
  it('property: output is null or 1 to 64 safe characters with no space at either end (any bytes)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const hex = `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as const;
        const out = decodeMemoText(hex);
        if (out === null) return true;
        return (
          out.length >= 1 &&
          out.length <= MEMO_TEXT_MAX_CHARS &&
          SAFE_TEXT.test(out) &&
          out === out.trim() &&
          !out.includes('  ')
        );
      }),
      { numRuns: 2000 },
    );
  });
  it('property: output is null or 1 to 64 safe characters with no space at either end (any text)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        const out = decodeMemoText(stringToHex(text));
        if (out === null) return true;
        return (
          out.length >= 1 &&
          out.length <= MEMO_TEXT_MAX_CHARS &&
          SAFE_TEXT.test(out) &&
          out === out.trim() &&
          !out.includes('  ')
        );
      }),
      { numRuns: 2000 },
    );
  });
  it('property: text made only of safe characters survives unchanged, up to the cap', () => {
    const safeChar = fc.constantFrom(...'ABCxyz0189._:-/=#@,+'.split(''));
    fc.assert(
      fc.property(fc.array(safeChar, { minLength: 1, maxLength: 64 }), (chars) => {
        const text = chars.join('');
        return decodeMemoText(stringToHex(text)) === text;
      }),
    );
  });
});

describe('memo reference: Memoline’s own format first, then plain text', () => {
  it('a Memoline memo gives its ref exactly as decodeMemoData does', () => {
    const hex = encodeMemoData({ v: 1, t: 'po', run: 'RUN1', row: 3, ref: 'INV-204' });
    expect(memoReference(hex)).toBe('INV-204');
    expect(memoReference(hex)).toBe(decodeMemoData(hex)?.ref);
  });
  it('a Memoline memo with no ref gives null, never its JSON as text', () => {
    expect(memoReference(encodeMemoData({ v: 1, t: 'pl', link: 'L1' }))).toBeNull();
    expect(memoReference(encodeMemoData({ v: 1, t: 'po', run: 'RUN1', row: 0 }))).toBeNull();
  });
  it('a memo from another app gives its cleaned text', () => {
    expect(memoReference(stringToHex('order=2026-0001'))).toBe('order=2026-0001');
  });
  it('an empty or binary memo gives null', () => {
    expect(memoReference('0x')).toBeNull();
    expect(memoReference('0xffff')).toBeNull();
  });
  it('property: for every Memoline memo, memoReference equals decodeMemoData(...).ref', () => {
    const ref = fc.stringMatching(/^[A-Za-z0-9._:-]{1,64}$/);
    fc.assert(
      fc.property(
        fc.constantFrom('po' as const, 'pl' as const, 'im' as const),
        fc.option(ref, { nil: undefined }),
        fc.option(fc.nat(99_999), { nil: undefined }),
        (t, r, row) => {
          const d = {
            v: 1 as const,
            t,
            ...(r === undefined ? {} : { ref: r }),
            ...(row === undefined ? {} : { row }),
          };
          const hex = encodeMemoData(d);
          return decodeMemoData(hex) !== null && memoReference(hex) === (decodeMemoData(hex)?.ref ?? null);
        },
      ),
    );
  });
});
