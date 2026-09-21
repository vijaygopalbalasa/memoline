import type { Address, Hex, Log, TransactionReceipt } from 'viem';
import { ADDRESSES, type ChainId } from '../chain/addresses.js';
import { computeFeeNative18 } from '../chain/fees.js';
import { decodeMemoData } from '../memo/data.js';
import { fromNative18 } from '../money/amount.js';
import { allocateFee } from './fees.js';
import { bracketFor, parseReceiptLogs } from './logs.js';
import type { LedgerEntry } from './types.js';

export type AddressReconcileInput = {
  chainId: ChainId;
  address: Address;
  logs: Log[];
  receiptsByTx: Map<Hex, TransactionReceipt>;
  blockTimes: Map<bigint, number>;
  importId: string;
};
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Dedups by (txHash, logIndex), same rule used to build `byTx` below. */
function dedupeLogs(logs: Log[]): Log[] {
  const seen = new Set<string>();
  const out: Log[] = [];
  for (const l of logs) {
    if (l.transactionHash === null || l.logIndex === null || l.blockNumber === null) continue;
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/**
 * Import: build ledger entries for one address from raw logs (system-emitter + EURC Transfer logs, Memo logs).
 * Dedups by (txHash, logIndex), ignores USDC-contract duplicates (parseReceiptLogs never reads value from
 * there), attaches memos via the bracket rule, and attributes the tx fee once (to the first entry, by log
 * order) only when the address paid for the transaction.
 */
export function reconcileAddress(input: AddressReconcileInput): LedgerEntry[] {
  const a = ADDRESSES[input.chainId];
  const seen = new Set<string>();
  const byTx = new Map<Hex, Log[]>();
  for (const l of input.logs) {
    if (l.transactionHash === null || l.logIndex === null || l.blockNumber === null) continue;
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const arr = byTx.get(l.transactionHash) ?? [];
    arr.push(l);
    byTx.set(l.transactionHash, arr);
  }

  const out: LedgerEntry[] = [];
  for (const [txHash, fetchedLogs] of byTx) {
    const receipt = input.receiptsByTx.get(txHash);
    // `fetchAddressLogs` only ever queries `Memo(sender)`, never `BeforeMemo` — so the address-scoped
    // fetched log set alone can never satisfy `bracketFor`'s BeforeMemo/Memo pairing, and memos would
    // never attach for live data. When the tx's receipt is available, use its full log set instead: it
    // carries BeforeMemo, every value transfer in the tx (transfers for other parties are filtered out
    // below by the isFrom/isTo check, same as always), and the USDC-contract duplicate that
    // `parseReceiptLogs` already ignores. Without a receipt (an anonymous import's receipt cap, or a
    // caller that never fetched one), fall back to the fetched set — memos won't attach for those, which
    // is the documented truncation.
    const logs = receipt ? dedupeLogs(receipt.logs) : fetchedLogs;
    const paidByAddress = receipt ? eq(receipt.from, input.address) : false;
    const fee = receipt ? computeFeeNative18(receipt.gasUsed, receipt.effectiveGasPrice) : 0n;
    const txEntries: LedgerEntry[] = [];

    for (const token of ['USDC', 'EURC'] as const) {
      const tokenAddr = token === 'USDC' ? a.usdc.address : a.eurc.address;
      const p = parseReceiptLogs(logs, {
        systemEmitter: a.systemEmitter.address,
        memo: a.memo.address,
        token: tokenAddr,
        tokenIsUsdc: token === 'USDC',
        usdc: a.usdc.address,
      });
      for (const t of p.transfers) {
        const isFrom = eq(t.from, input.address);
        const isTo = eq(t.to, input.address);
        if (!isFrom && !isTo) continue;
        const memo =
          p.memos.find((m) => {
            const br = bracketFor(m, p.beforeMemos);
            return br !== null && t.logIndex > br.lo && t.logIndex < br.hi;
          }) ?? null;

        let amount6: bigint;
        let amountNative18: bigint | null;
        let note: string | null = null;
        if (token === 'USDC') {
          const s = fromNative18(t.value);
          amount6 = s.amount6;
          amountNative18 = t.value;
          if (s.dust > 0n) note = `includes ${s.dust} dust (sub-6dp native units)`;
        } else {
          amount6 = t.value;
          amountNative18 = null;
        }

        txEntries.push({
          direction: isFrom && isTo ? 'self' : isFrom ? 'out' : 'in',
          token,
          amount6,
          amountNative18,
          counterparty: isFrom ? t.to : t.from,
          txHash,
          logIndex: t.logIndex,
          memoId: memo?.memoId ?? null,
          memoIndex: memo?.memoIndex ?? null,
          reference: memo ? (decodeMemoData(memo.memo)?.ref ?? null) : null,
          sourceType: 'import',
          sourceId: input.importId,
          blockNumber: t.blockNumber,
          blockTime: input.blockTimes.get(t.blockNumber) ?? 0,
          feeNative18: 0n,
          note,
        });
      }
    }

    txEntries.sort((x, y) => x.logIndex - y.logIndex);
    if (paidByAddress) {
      if (txEntries.length > 0) {
        // Same split as the payout side (`reconcileReceipt`): pro rata by line, remainder on the
        // first, so the payer's run export and an import of the same address agree line by line
        // and both sum to the receipt's exact fee.
        const parts = allocateFee(fee, txEntries.length);
        txEntries.forEach((e, i) => {
          e.feeNative18 = parts[i] ?? 0n;
        });
      } else if (fee > 0n) {
        // The address paid for this transaction but moved no USDC/EURC of its own (a memo'd call
        // that moved someone else's funds, a contract interaction). The gas is still real money out
        // of this address; a gas-only line keeps the books tying out. logIndex -1 is the same
        // sentinel the payout side uses for a reverted chunk's gas.
        txEntries.push({
          direction: 'self',
          token: 'USDC',
          amount6: 0n,
          amountNative18: null,
          counterparty: input.address,
          txHash,
          logIndex: -1,
          memoId: null,
          memoIndex: null,
          reference: null,
          sourceType: 'import',
          sourceId: input.importId,
          blockNumber: receipt?.blockNumber ?? 0n,
          blockTime: input.blockTimes.get(receipt?.blockNumber ?? 0n) ?? 0,
          feeNative18: fee,
          note: 'gas only: this address paid for the transaction but no USDC or EURC moved to or from it',
        });
      }
    }
    out.push(...txEntries);
  }

  return out.sort((x, y) =>
    x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1,
  );
}
