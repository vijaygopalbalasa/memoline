/** Pro-rata by row count; remainder to the first row so the parts sum exactly to the total. */
export function allocateFee(total: bigint, n: number): bigint[] {
  if (n <= 0) return [];
  const base = total / BigInt(n);
  const rem = total - base * BigInt(n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + rem : base));
}
