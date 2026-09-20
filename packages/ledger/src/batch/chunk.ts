import type { Address, Hex } from 'viem';
import { encodeMemoData } from '../memo/data.js';
import { payoutMemoId } from '../memo/ids.js';

export type PayoutRow = {
  rowIndex: number;
  recipient: Address;
  amount6: bigint;
  reference: string;
  memoId: Hex;
  memoData: Hex;
};

export type Chunk = { idx: number; rows: PayoutRow[] };

export function makePayoutRow(
  runId: string,
  rowIndex: number,
  recipient: Address,
  amount6: bigint,
  reference: string,
): PayoutRow {
  return {
    rowIndex,
    recipient,
    amount6,
    reference,
    memoId: payoutMemoId(runId, rowIndex),
    memoData: encodeMemoData({ v: 1, t: 'po', run: runId, row: rowIndex, ref: reference }),
  };
}

/** Deterministic, order-preserving chunking. Chunk idx is the position in the run. */
export function chunkRows(rows: PayoutRow[], maxRows: number): Chunk[] {
  if (!Number.isInteger(maxRows) || maxRows < 1)
    throw new Error(`maxRows must be a positive integer, got ${maxRows}`);
  const out: Chunk[] = [];
  for (let i = 0; i < rows.length; i += maxRows)
    out.push({ idx: out.length, rows: rows.slice(i, i + maxRows) });
  return out;
}
