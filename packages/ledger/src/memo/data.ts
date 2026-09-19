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

export function encodeMemoData(d: MemoData): Hex {
  if (d.ref !== undefined && !REFERENCE_RE.test(d.ref)) {
    throw new Error(`Invalid reference "${d.ref}": allowed [A-Za-z0-9._:-], 1–64 chars`);
  }
  const json = JSON.stringify(d);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > MEMO_DATA_MAX_BYTES)
    throw new Error(`memoData is ${bytes} bytes; limit is ${MEMO_DATA_MAX_BYTES}`);
  return stringToHex(json);
}

export function decodeMemoData(hex: Hex): MemoData | null {
  if (!hex || hex === '0x') return null;
  try {
    const parsed: unknown = JSON.parse(hexToString(hex));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (o.v !== 1 || !['po', 'pl', 'im'].includes(String(o.t))) return null;
    return o as MemoData;
  } catch {
    return null;
  }
}
