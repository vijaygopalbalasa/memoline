import { type Hex, hexToBytes, hexToString, stringToHex } from 'viem';

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

/** Longest reference kept from a memo written by another app. */
export const MEMO_TEXT_MAX_CHARS = 64;

/** Strict UTF-8: bytes that are not valid text are binary (a hash, an ABI blob), not a reference. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });
/** Anything shaped like an HTML/XML tag, a comment or a processing instruction, removed whole. */
const MARKUP_RE = /<\/?[A-Za-z!?][^<>]*>/g;
/** Every kind of whitespace (tabs, line breaks, non-breaking spaces), except the zero-width BOM. */
const WHITESPACE_RE = /[^\S\uFEFF]/g;
/** Everything outside the safe set: ASCII letters, digits, space and . _ : - / = # @ , + */
const UNSAFE_RE = /[^A-Za-z0-9 ._:\-/=#@,+]/g;

function plainMemoText(hex: Hex): string | null {
  if (!hex || hex === '0x') return null;
  let text: string;
  try {
    text = UTF8.decode(hexToBytes(hex));
  } catch {
    return null;
  }
  const clean = text
    .replace(MARKUP_RE, '')
    .replace(WHITESPACE_RE, ' ')
    .replace(UNSAFE_RE, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, MEMO_TEXT_MAX_CHARS)
    .trimEnd();
  return clean === '' ? null : clean;
}

/**
 * Reads a memo written by another Arc app as a plain text reference. Arc's own tutorial writes
 * memo bytes as `stringToHex('order=2026-0001')`, which is not Memoline's JSON format.
 *
 * The bytes are attacker-controlled and end up on screen and in exports, so the text is cleaned:
 * strict UTF-8 only (anything else is binary and gives null), markup tags removed whole, every
 * character outside the safe set dropped (this removes control characters, quotes, angle brackets,
 * direction overrides and all non-ASCII), whitespace collapsed to single spaces, and the result
 * capped at 64 characters. Returns null when nothing printable remains, and null for Memoline's
 * own format, which `decodeMemoData` reads instead.
 */
export function decodeMemoText(memoData: Hex): string | null {
  if (decodeMemoData(memoData) !== null) return null;
  return plainMemoText(memoData);
}

/**
 * The reference a ledger line shows for a memo: Memoline's own `ref` when the bytes are
 * Memoline's format (null when that memo has no ref), otherwise the cleaned text another app wrote.
 */
export function memoReference(memoData: Hex): string | null {
  const own = decodeMemoData(memoData);
  if (own !== null) return own.ref ?? null;
  return plainMemoText(memoData);
}
