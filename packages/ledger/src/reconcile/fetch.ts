import { type Address, erc20Abi, getAbiItem, type Log, type PublicClient } from 'viem';
import { memoAbi } from '../chain/abis/memo.js';
import { ADDRESSES, type ChainId } from '../chain/addresses.js';
import { PARAMS } from '../chain/params.js';
import { mapRpcError } from '../errors.js';

export type FetchClient = Pick<PublicClient, 'getLogs'>;
export type FetchOptions = {
  chainId: ChainId;
  address: Address;
  fromBlock: bigint;
  toBlock: bigint;
  onPage?: (p: { from: bigint; to: bigint; logs: number }) => void;
  sleepMs?: number;
  maxAttempts?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const transferEvent = getAbiItem({ abi: erc20Abi, name: 'Transfer' });
const memoEvent = getAbiItem({ abi: memoAbi, name: 'Memo' });

/**
 * Retries one `getLogs` call in place (same block range) with linear backoff on rate limiting / unknown
 * transport errors. A "range too large" error is NOT retried here — it means the range itself must shrink,
 * which is a page-level decision the caller makes (it affects all 5 queries for this page, not just this one).
 */
async function callWithRetry(
  fn: () => Promise<readonly Log[]>,
  maxAttempts: number,
  sleepMs: number,
): Promise<readonly Log[]> {
  let attempts = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const err = mapRpcError(e);
      if (err.code === 'RPC_RANGE_TOO_LARGE') throw e;
      attempts++;
      if (attempts > maxAttempts) throw new Error(`fetchAddressLogs gave up: ${err.code} — ${err.message}`);
      if (err.code === 'RPC_RATE_LIMITED' || err.code === 'UNKNOWN') {
        await sleep(sleepMs * attempts);
        continue;
      }
      throw new Error(`fetchAddressLogs failed: ${err.code} — ${err.message}`);
    }
  }
}

/**
 * All logs relevant to an address: system-emitter Transfer (from/to), EURC Transfer (from/to), Memo (sender).
 * Adaptive paging: start big (indexed-arg filters are sparse), halve the page on "range too large" and retry
 * the whole page at the smaller size, grow the page back on success. A rate limit / unknown error retries
 * just the one failing call in place (same range) with linear backoff, so an intermittent 429 doesn't force
 * re-fetching calls that already succeeded.
 */
export async function fetchAddressLogs(client: FetchClient, o: FetchOptions): Promise<Log[]> {
  if (o.fromBlock > o.toBlock) throw new Error(`invalid block range ${o.fromBlock}..${o.toBlock}`);
  const a = ADDRESSES[o.chainId];
  const out: Log[] = [];
  let page = BigInt(PARAMS.logPageBlocks.start);
  const min = BigInt(PARAMS.logPageBlocks.min);
  const max = BigInt(PARAMS.logPageBlocks.max);
  const maxAttempts = o.maxAttempts ?? 12;
  const sleepMs = o.sleepMs ?? 500;
  let from = o.fromBlock;
  let rangeAttempts = 0;

  while (from <= o.toBlock) {
    const to = from + page - 1n > o.toBlock ? o.toBlock : from + page - 1n;
    // Each closure is declared separately (not inside a pre-typed array literal): an explicit
    // `Array<() => Promise<...>>` annotation on the array would contextually type each call
    // before its `event`/`args` are inspected, and getLogs' generic overload picker would then
    // pick the untyped "no event" branch and reject `args` as extraneous.
    const q1 = () =>
      client.getLogs({
        address: a.systemEmitter.address,
        event: transferEvent,
        args: { from: o.address },
        fromBlock: from,
        toBlock: to,
      });
    const q2 = () =>
      client.getLogs({
        address: a.systemEmitter.address,
        event: transferEvent,
        args: { to: o.address },
        fromBlock: from,
        toBlock: to,
      });
    const q3 = () =>
      client.getLogs({
        address: a.eurc.address,
        event: transferEvent,
        args: { from: o.address },
        fromBlock: from,
        toBlock: to,
      });
    const q4 = () =>
      client.getLogs({
        address: a.eurc.address,
        event: transferEvent,
        args: { to: o.address },
        fromBlock: from,
        toBlock: to,
      });
    const q5 = () =>
      client.getLogs({
        address: a.memo.address,
        event: memoEvent,
        args: { sender: o.address },
        fromBlock: from,
        toBlock: to,
      });
    const queries = [q1, q2, q3, q4, q5];

    try {
      const pageLogs: Log[] = [];
      let n = 0;
      for (const q of queries) {
        const logs = await callWithRetry(q, maxAttempts, sleepMs);
        pageLogs.push(...(logs as Log[]));
        n += logs.length;
      }
      out.push(...pageLogs);
      o.onPage?.({ from, to, logs: n });
      from = to + 1n;
      rangeAttempts = 0;
      if (page < max) page = page * 2n > max ? max : page * 2n;
    } catch (e) {
      const err = mapRpcError(e);
      if (err.code !== 'RPC_RANGE_TOO_LARGE') {
        throw new Error(`fetchAddressLogs failed at block ${from}: ${err.code} — ${err.message}`);
      }
      rangeAttempts++;
      if (rangeAttempts > maxAttempts) {
        throw new Error(`fetchAddressLogs gave up at block ${from}: ${err.code}`);
      }
      page = page / 2n < min ? min : page / 2n;
    }
  }
  return out;
}
