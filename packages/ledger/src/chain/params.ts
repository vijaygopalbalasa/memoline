/** Set from Spike 0 results (OPEN_QUESTIONS.md §D). Until then: Mode A, 50 rows. */
export const PARAMS = {
  mode: 'A' as 'A' | 'B' | 'C',
  maxRowsPerTx: 50,
  memoDataMaxBytes: 256,
  logPageBlocks: { start: 200_000, min: 2_000, max: 500_000 },
} as const;
