/**
 * Set from Spike 0 on Arc Testnet, 2026-09-19 (OPEN_QUESTIONS.md §D).
 * Mode A confirmed (sender preserved through Multicall3From → Memo). Measured ~53k gas/row;
 * 100 rows ≈ 4.5M gas = 27% of the 16,777,216 EIP-7825 cap (200 rows estimated at 7.3M, also under cap).
 */
export const PARAMS = {
  mode: 'A' as 'A' | 'B' | 'C',
  maxRowsPerTx: 100,
  memoDataMaxBytes: 256,
  logPageBlocks: { start: 200_000, min: 2_000, max: 500_000 },
} as const;
