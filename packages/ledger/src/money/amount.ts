/**
 * Money math for Arc. One USDC balance, two scales:
 *  - amount6:  token base units through the ERC-20 interface (6 dp) — what we send and display
 *  - native18: native units (18 dp) — what the system emitter logs and what gas is charged in
 * All values are bigint. No floats anywhere in this module.
 */

export const SCALE_6 = 1_000_000n;
export const SCALE_12 = 1_000_000_000_000n; // native18 / amount6
export const UINT256_MAX = (1n << 256n) - 1n;

export class AmountError extends Error {
  readonly code = 'AMOUNT_OUT_OF_RANGE' as const;
  constructor(
    message: string,
    readonly input: string,
  ) {
    super(message);
    this.name = 'AmountError';
  }
}

/** Strict decimal parser: ASCII digits, optional single '.', ≤ 6 fractional digits, > 0. Nothing else. */
const DECIMAL_RE = /^(\d*)(?:\.(\d{0,6}))?$/;

export function parseAmount6(input: string): bigint {
  const s = input.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m || s === '' || s === '.')
    throw new AmountError(
      `Invalid amount "${input}": use plain decimals with at most 6 decimal places`,
      input,
    );
  const whole = m[1] ?? '';
  const frac = (m[2] ?? '').padEnd(6, '0');
  if (whole === '' && (m[2] ?? '') === '') throw new AmountError(`Invalid amount "${input}"`, input);
  const value = BigInt(whole || '0') * SCALE_6 + BigInt(frac);
  if (value === 0n) throw new AmountError(`Amount must be greater than zero (got "${input}")`, input);
  if (value > UINT256_MAX) throw new AmountError(`Amount "${input}" exceeds uint256`, input);
  return value;
}

export function toNative18(amount6: bigint): bigint {
  return amount6 * SCALE_12;
}

/** Splits a native value into the 6-dp part and the sub-6-dp dust. Dust is real balance; never discard it silently. */
export function fromNative18(native18: bigint): { amount6: bigint; dust: bigint } {
  return { amount6: native18 / SCALE_12, dust: native18 % SCALE_12 };
}

/** Canonical display: at least 2 dp, up to 6, trailing zeros beyond 2 trimmed. */
export function format6(amount6: bigint): string {
  const neg = amount6 < 0n;
  const abs = neg ? -amount6 : amount6;
  const whole = abs / SCALE_6;
  let frac = (abs % SCALE_6).toString().padStart(6, '0');
  frac = frac.replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function formatNative18(native18: bigint): string {
  const { amount6, dust } = fromNative18(native18);
  const base = format6(amount6);
  return dust === 0n ? base : `${base} (+${dust} dust)`;
}
