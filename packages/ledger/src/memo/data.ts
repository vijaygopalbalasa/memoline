import { type Hex, hexToString, stringToHex } from 'viem';

export const MEMO_DATA_MAX_BYTES = 256;
/** References are public and permanent on-chain: opaque IDs and invoice references only. */
export const REFERENCE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

export type MemoData = {
  v: 1;
  t: 'po' | 'pl' | 'im';
  run?: string;
  row?: number;
  link?: string;
  ref?: string;
};

function isValidRef(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_RE.test(value);
}

function isValidRow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function encodeMemoData(d: MemoData): Hex {
  if (d.run !== undefined && !REFERENCE_RE.test(d.run)) {
    throw new Error(`Invalid run id "${d.run}": allowed [A-Za-z0-9._:-], 1–64 chars`);
  }
  if (d.link !== undefined && !REFERENCE_RE.test(d.link)) {
    throw new Error(`Invalid link id "${d.link}": allowed [A-Za-z0-9._:-], 1–64 chars`);
  }
  if (d.ref !== undefined && !REFERENCE_RE.test(d.ref)) {
    throw new Error(`Invalid reference "${d.ref}": allowed [A-Za-z0-9._:-], 1–64 chars`);
  }
  const json = JSON.stringify(d);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MEMO_DATA_MAX_BYTES)
    throw new Error(`memoData is ${bytes} bytes; limit is ${MEMO_DATA_MAX_BYTES}`);
  return stringToHex(json);
}

/**
 * On-chain memo bytes are attacker-controlled: every field is type- and charset-checked before
 * being copied into the result, and unknown keys are dropped rather than passed through.
 */
export function decodeMemoData(hex: Hex): MemoData | null {
  if (!hex || hex === '0x') return null;
  try {
    const parsed: unknown = JSON.parse(hexToString(hex));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1) return null;
    if (o.t !== 'po' && o.t !== 'pl' && o.t !== 'im') return null;

    const out: MemoData = { v: 1, t: o.t };

    if (o.run !== undefined) {
      if (!isValidRef(o.run)) return null;
      out.run = o.run;
    }
    if (o.link !== undefined) {
      if (!isValidRef(o.link)) return null;
      out.link = o.link;
    }
    if (o.ref !== undefined) {
      if (!isValidRef(o.ref)) return null;
      out.ref = o.ref;
    }
    if (o.row !== undefined) {
      if (!isValidRow(o.row)) return null;
      out.row = o.row;
    }

    return out;
  } catch {
    return null;
  }
}
