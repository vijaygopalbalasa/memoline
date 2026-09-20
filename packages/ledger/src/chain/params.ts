/**
 * Set from Spike 0 on Arc Testnet, 2026-09-19 (OPEN_QUESTIONS.md §D).
 * Mode A confirmed (sender preserved through Multicall3From → Memo). Measured ~53k gas/row;
 * 100 rows ≈ 4.5M gas = 27% of the 16,777,216 EIP-7825 cap (200 rows estimated at 7.3M, also under cap).
 * `logPageBlocks.min` lowered to 500 after Task 17's `import-e2e` run against live Arc Testnet: some
 * free-tier RPC providers reject ranges far smaller than their own error message claims (dRPC's
 * "ranges over 10000 blocks" message was seen failing at 500 blocks already, though a 100-block page
 * did succeed there) — a 500-block floor gives `fetchAddressLogs`'s adaptive halving more room before
 * giving up. See `scripts/testnet/lib.ts` for the current recommended fallback RPC.
 */
export const PARAMS = {
  mode: 'A' as 'A' | 'B' | 'C',
  maxRowsPerTx: 100,
  memoDataMaxBytes: 256,
  logPageBlocks: { start: 200_000, min: 500, max: 500_000 },
} as const;
