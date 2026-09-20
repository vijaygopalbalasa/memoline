import { type Address, keccak256, type TransactionReceipt } from 'viem';
import { buildTransferCalldata } from '../batch/build.js';
import type { Chunk } from '../batch/chunk.js';
import { ADDRESSES, type ChainId, type Token, tokenAddress } from '../chain/addresses.js';
import { computeFeeNative18 } from '../chain/fees.js';
import { fromNative18, SCALE_12 } from '../money/amount.js';
import { allocateFee } from './fees.js';
import { bracketFor, parseReceiptLogs } from './logs.js';
import type { LedgerEntry, ReceiptReconciliation, RowOutcome } from './types.js';

export type ReceiptContext = {
  chainId: ChainId;
  sender: Address;
  token: Token;
  chunk: Chunk;
  runId: string;
  blockTime: number;
};
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * SPEC §6.7. For each expected row: find its Memo event (by memoId), verify sender/target/callDataHash,
 * then find exactly one value Transfer inside the BeforeMemo…Memo bracket with the right from/to/value.
 * Match → RECONCILED + one entry. Anything else → EXCEPTION with the precise reason. USDC-contract logs
 * are never used as a source of truth (only counted, for the trap check).
 */
export function reconcileReceipt(receipt: TransactionReceipt, ctx: ReceiptContext): ReceiptReconciliation {
  const a = ADDRESSES[ctx.chainId];
  const token = tokenAddress(ctx.chainId, ctx.token);
  const isUsdc = ctx.token === 'USDC';
  const chunkFeeNative18 = computeFeeNative18(receipt.gasUsed, receipt.effectiveGasPrice);
  const expectedCount = ctx.chunk.rows.length;

  if (receipt.status !== 'success') {
    return {
      entries: [],
      chunkFeeNative18,
      rows: ctx.chunk.rows.map((r) => ({
        rowIndex: r.rowIndex,
        status: 'EXCEPTION',
        reason: 'transaction reverted on-chain; nothing was paid',
      })),
      checks: {
        matchedCount: 0,
        expectedCount,
        sumOk: false,
        unexplainedTransfers: 0,
        duplicateUsdcContractLogs: 0,
      },
    };
  }

  const { transfers, memos, beforeMemos, duplicateUsdcContractLogs } = parseReceiptLogs(receipt.logs, {
    systemEmitter: a.systemEmitter.address,
    memo: a.memo.address,
    token,
    tokenIsUsdc: isUsdc,
    usdc: a.usdc.address,
  });

  const rows: RowOutcome[] = [];
  const entries: LedgerEntry[] = [];
  const used = new Set<number>();
  /** Sum of the matched transfers' actual on-chain values, in amount6 — chain data, kept separate
   * from the rows' declared expectation so `sumOk` below is a real cross-check, not a comparison of
   * `row.amount6` against itself. */
  let sumMatchedOnChain = 0n;

  for (const row of ctx.chunk.rows) {
    const fail = (reason: string) => rows.push({ rowIndex: row.rowIndex, status: 'EXCEPTION', reason });

    const memo = memos.find((m) => m.memoId === row.memoId);
    if (!memo) {
      fail(`no Memo event with memoId ${row.memoId}`);
      continue;
    }
    if (!eq(memo.sender, ctx.sender)) {
      fail(`Memo sender ${memo.sender} is not the run sender ${ctx.sender}`);
      continue;
    }
    if (!eq(memo.target, token)) {
      fail(`Memo target ${memo.target} is not the token ${token}`);
      continue;
    }
    const expectedHash = keccak256(buildTransferCalldata(row.recipient, row.amount6));
    if (memo.callDataHash !== expectedHash) {
      fail('callDataHash mismatch: recipient/amount differ from the row');
      continue;
    }
    const br = bracketFor(memo, beforeMemos);
    if (!br) {
      fail(`no BeforeMemo(${memo.memoIndex}) before the Memo event`);
      continue;
    }
    const expectedValue = isUsdc ? row.amount6 * SCALE_12 : row.amount6;
    const inBracket = transfers.filter(
      (t) =>
        br !== null &&
        t.logIndex > br.lo &&
        t.logIndex < br.hi &&
        !used.has(t.logIndex) &&
        eq(t.from, ctx.sender) &&
        eq(t.to, row.recipient) &&
        t.value === expectedValue,
    );
    if (inBracket.length !== 1) {
      fail(
        `expected exactly one transfer of ${expectedValue} to ${row.recipient} inside the memo bracket, found ${inBracket.length}`,
      );
      continue;
    }
    const t = inBracket[0];
    if (!t) {
      fail('internal: matched transfer disappeared');
      continue;
    }
    used.add(t.logIndex);
    rows.push({ rowIndex: row.rowIndex, status: 'RECONCILED' });
    sumMatchedOnChain += isUsdc ? fromNative18(t.value).amount6 : t.value;
    entries.push({
      direction: 'out',
      token: ctx.token,
      amount6: row.amount6,
      amountNative18: isUsdc ? t.value : null,
      counterparty: row.recipient,
      txHash: receipt.transactionHash,
      logIndex: t.logIndex,
      memoId: memo.memoId,
      memoIndex: memo.memoIndex,
      sourceType: 'payout',
      sourceId: `${ctx.runId}:${row.rowIndex}`,
      blockNumber: receipt.blockNumber,
      blockTime: ctx.blockTime,
      feeNative18: 0n,
      note: null,
    });
  }

  const fees = allocateFee(chunkFeeNative18, entries.length);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry) entry.feeNative18 = fees[i] ?? 0n;
  }

  const unexplainedTransfers = transfers.filter(
    (t) => eq(t.from, ctx.sender) && !used.has(t.logIndex),
  ).length;
  const sumExpected = ctx.chunk.rows
    .filter((r) => rows.find((x) => x.rowIndex === r.rowIndex)?.status === 'RECONCILED')
    .reduce((s, r) => s + r.amount6, 0n);

  return {
    entries,
    rows,
    chunkFeeNative18,
    checks: {
      matchedCount: entries.length,
      expectedCount,
      // A statement about chain data: the sum of what was actually transferred on-chain (decoded from
      // the matched Transfer logs) equals the sum of what the reconciled rows expected — not a
      // comparison of our own expectation against itself. Defense-in-depth: true by construction
      // today, since the bracket filter above only accepts a transfer whose value exactly equals
      // `expectedValue`; it exists to keep meaning this check if that filter is ever loosened.
      sumOk: sumExpected === sumMatchedOnChain,
      unexplainedTransfers,
      duplicateUsdcContractLogs,
    },
  };
}
