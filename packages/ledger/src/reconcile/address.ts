import type { Address, Hex, Log, TransactionReceipt } from 'viem';
import { ADDRESSES, type ChainId } from '../chain/addresses.js';
import { computeFeeNative18 } from '../chain/fees.js';
import { fromNative18 } from '../money/amount.js';
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
    const first = txEntries[0];
    if (paidByAddress && first) first.feeNative18 = fee;
    out.push(...txEntries);
  }

  return out.sort((x, y) =>
    x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1,
  );
}
