import type { Address, Hex } from 'viem';
import type { Token } from '../chain/addresses.js';

export type LedgerEntry = {
  direction: 'out' | 'in' | 'self';
  token: Token;
  amount6: bigint;
  /** Native (18 dp) value for USDC from the system emitter; null for other tokens. */
  amountNative18: bigint | null;
  counterparty: Address;
  txHash: Hex;
  logIndex: number;
  memoId: Hex | null;
  memoIndex: bigint | null;
  sourceType: 'payout' | 'import';
  sourceId: string | null;
  blockNumber: bigint;
  blockTime: number;
  /** Gas fee attributed to this entry, in native units. Sums to the transaction fee across a chunk. */
  feeNative18: bigint;
  note: string | null;
};

export type RowOutcome = { rowIndex: number; status: 'RECONCILED' | 'EXCEPTION'; reason?: string };

export type ReceiptReconciliation = {
  entries: LedgerEntry[];
  rows: RowOutcome[];
  chunkFeeNative18: bigint;
  checks: {
    matchedCount: number;
    expectedCount: number;
    sumOk: boolean;
    unexplainedTransfers: number;
    duplicateUsdcContractLogs: number;
  };
};
