/**
 * Set from Spike 0 on Arc Testnet, 2026-09-19.
 * Mode A confirmed (sender preserved through Multicall3From → Memo). Measured ~53k gas/row;
 * 100 rows ≈ 4.5M gas = 27% of the 16,777,216 EIP-7825 cap (200 rows estimated at 7.3M, also under cap).
 */
export const PARAMS = {
  mode: 'A' as 'A' | 'B' | 'C',
  maxRowsPerTx: 100,
  memoDataMaxBytes: 256,
  // start/max: 10,000 is the largest eth_getLogs range any provider that serves Arc history accepts
  // today — measured 2026-09-22 on the QuickNode public mirror (10,000 blocks ok, 10,001 → -32012
  // "requested range too large"); Alchemy's free tier allows 10 and dRPC's ~100. Starting higher only
  // buys a rejected call per page (the pager used to start at 200,000 and re-grow past the cap after
  // every success). Raise `max` if a provider with a larger cap appears; the pager still halves on
  // rejection and remembers the rejected size (see fetch.ts `pageBlockRange`).
  // min: lowered from 2,000 to 500 after Task 17's import-e2e run against live Arc Testnet — gives
  // the adaptive halving more room before giving up on a stingy provider. dRPC's free tier fails
  // eth_getLogs *below* this value (observed failing at 500 blocks, succeeding at 100; its own
  // "ranges over 10000 blocks" error message overstates the real cap) — it must not be used as a
  // fallback RPC. See scripts/testnet/lib.ts / .env.example for the QuickNode fallback.
  logPageBlocks: { start: 10_000, min: 500, max: 10_000 },
} as const;
