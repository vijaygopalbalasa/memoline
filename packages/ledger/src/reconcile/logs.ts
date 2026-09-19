import { type Address, erc20Abi, type Hex, type Log, parseEventLogs } from 'viem';
import { memoAbi } from '../chain/abis/memo.js';

export type TransferLog = {
  from: Address;
  to: Address;
  value: bigint;
  logIndex: number;
  txHash: Hex;
  blockNumber: bigint;
  emitter: Address;
};
export type MemoLog = {
  sender: Address;
  target: Address;
  callDataHash: Hex;
  memoId: Hex;
  memo: Hex;
  memoIndex: bigint;
  logIndex: number;
  txHash: Hex;
  blockNumber: bigint;
};
export type BeforeMemoLog = { memoIndex: bigint; logIndex: number; txHash: Hex };

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Splits logs into the streams the reconciler needs.
 * USDC: value transfers come from the system emitter (18 dp). The USDC contract's own Transfer log is a
 * duplicate and is only counted, never treated as a value movement.
 * Other tokens: transfers come from the token contract itself (token decimals).
 */
export function parseReceiptLogs(
  logs: Log[],
  a: { systemEmitter: Address; memo: Address; token: Address; tokenIsUsdc: boolean; usdc: Address },
): {
  transfers: TransferLog[];
  memos: MemoLog[];
  beforeMemos: BeforeMemoLog[];
  duplicateUsdcContractLogs: number;
} {
  const valueEmitter = a.tokenIsUsdc ? a.systemEmitter : a.token;
  const duplicateUsdcContractLogs = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: logs.filter((l) => eq(l.address, a.usdc)),
    strict: true,
  }).length;

  const transfers: TransferLog[] = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: logs.filter((l) => eq(l.address, valueEmitter)),
    strict: true,
  }).map((l) => ({
    from: l.args.from,
    to: l.args.to,
    value: l.args.value,
    logIndex: l.logIndex,
    txHash: l.transactionHash,
    blockNumber: l.blockNumber,
    emitter: l.address,
  }));

  const memoLogs = parseEventLogs({
    abi: memoAbi,
    logs: logs.filter((l) => eq(l.address, a.memo)),
    strict: true,
  });
  const memos: MemoLog[] = [];
  const beforeMemos: BeforeMemoLog[] = [];
  for (const l of memoLogs) {
    if (l.eventName === 'Memo') {
      memos.push({ ...l.args, logIndex: l.logIndex, txHash: l.transactionHash, blockNumber: l.blockNumber });
    } else {
      beforeMemos.push({ memoIndex: l.args.memoIndex, logIndex: l.logIndex, txHash: l.transactionHash });
    }
  }

  const byIdx = (x: { logIndex: number }, y: { logIndex: number }) => x.logIndex - y.logIndex;
  return {
    transfers: transfers.sort(byIdx),
    memos: memos.sort(byIdx),
    beforeMemos: beforeMemos.sort(byIdx),
    duplicateUsdcContractLogs,
  };
}

/** The Transfer for memo i sits strictly between BeforeMemo(i) and Memo(i) in log order. */
export function bracketFor(memo: MemoLog, beforeMemos: BeforeMemoLog[]): { lo: number; hi: number } | null {
  const candidates = beforeMemos.filter((x) => x.memoIndex === memo.memoIndex && x.logIndex < memo.logIndex);
  const b = candidates.at(-1);
  return b ? { lo: b.logIndex, hi: memo.logIndex } : null;
}
