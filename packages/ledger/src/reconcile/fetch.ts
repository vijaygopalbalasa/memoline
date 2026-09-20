import { type Address, erc20Abi, getAbiItem, type Log, type PublicClient } from 'viem';
import { memoAbi } from '../chain/abis/memo.js';
import { ADDRESSES, type ChainId } from '../chain/addresses.js';
import { PARAMS } from '../chain/params.js';
import { type LedgerError, mapRpcError } from '../errors.js';

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

/** How many times an `UNKNOWN`-coded failure is retried in place before escalating to a page-size halve.
 * Some RPC providers reject an oversized range with a code/message `mapRpcError` doesn't recognise as
 * `RPC_RANGE_TOO_LARGE` (only -32602 + /range/ is), so it comes back `UNKNOWN`. A couple of in-place
 * retries absorb a genuinely transient `UNKNOWN` (a flaky node); one that keeps failing is very likely a
 * disguised range error, so the caller then treats it like one. */
const UNKNOWN_INPLACE_RETRIES = 2;

/** A sustained rate limit (observed on Arc's primary RPC under heavy paging) needs a more patient
 * backoff than a plain retry: double the per-attempt sleep (so the production default of 500ms
 * becomes 1000ms × attempt) and cap it at 10s so a high `maxAttempts` can't balloon into minutes.
 * Scaling off the caller's `sleepMs` — rather than a bare constant — keeps a caller-supplied
 * `sleepMs: 0` (every test in fetch.test.ts) instant, while production's default gets the intended
 * longer wait. */
const RATE_LIMIT_BACKOFF_MULTIPLIER = 2;
const RATE_LIMIT_BACKOFF_CAP_MS = 10_000;

/**
 * Thrown by `callWithRetry` when it stops retrying a call in place — either because the range itself
 * must shrink (a page-level decision, `RPC_RANGE_TOO_LARGE` or an `UNKNOWN` that outlasted its in-place
 * retries) or because retries are exhausted / the error isn't retryable at all. Carries the already-mapped
 * `LedgerError` so `fetchAddressLogs` can branch on `.code` directly instead of re-deriving it by calling
 * `mapRpcError` a second time on this error's own (by-then generic) message text.
 */
class FetchGiveUp extends Error {
  constructor(readonly ledger: LedgerError) {
    super(`${ledger.code} — ${ledger.message}${detailSuffix(ledger)}`);
    this.name = 'FetchGiveUp';
  }
}

/** The raw provider text (`LedgerError.detail`), when present, appended to a give-up message — the
 * generic per-code message ("The RPC rejected the log query as too large") is the same for every
 * provider, but the detail is what actually tells you which provider and why (e.g. dRPC's
 * "ranges over 10000 blocks are not supported on free plan", which understates its own real cap). */
function detailSuffix(ledger: LedgerError): string {
  return ledger.detail === undefined ? '' : ` (provider said: ${String(ledger.detail)})`;
}

/**
 * Retries one `getLogs` call in place (same block range) with linear backoff on rate limiting.
 * `RPC_RANGE_TOO_LARGE` is never retried here — it means the range itself must shrink, which is a
 * page-level decision the caller makes (it affects all 5 queries for this page, not just this one).
 * `UNKNOWN` gets a few in-place attempts, then gives up so the caller can fall back to page halving the
 * same way it does for an explicit range-too-large error. Every other code (`RPC_FORBIDDEN`,
 * `RPC_HISTORY_UNAVAILABLE`, …) is not retryable and gives up immediately on the first attempt.
 */
async function callWithRetry(
  fn: () => Promise<readonly Log[]>,
  maxAttempts: number,
  sleepMs: number,
): Promise<readonly Log[]> {
  let rateAttempts = 0;
  let unknownAttempts = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const err = mapRpcError(e);
      if (err.code === 'RPC_RANGE_TOO_LARGE') throw new FetchGiveUp(err);
      if (err.code === 'UNKNOWN') {
        unknownAttempts++;
        if (unknownAttempts > UNKNOWN_INPLACE_RETRIES) throw new FetchGiveUp(err);
        await sleep(sleepMs * unknownAttempts);
        continue;
      }
      if (err.code === 'RPC_RATE_LIMITED') {
        rateAttempts++;
        if (rateAttempts > maxAttempts) throw new FetchGiveUp(err);
        await sleep(
          Math.min(sleepMs * RATE_LIMIT_BACKOFF_MULTIPLIER * rateAttempts, RATE_LIMIT_BACKOFF_CAP_MS),
        );
        continue;
      }
      // Not retryable (RPC_FORBIDDEN, RPC_HISTORY_UNAVAILABLE, TX_REVERTED, …): fail fast.
      throw new FetchGiveUp(err);
    }
  }
}

/**
 * All logs relevant to an address: system-emitter Transfer (from/to), EURC Transfer (from/to), Memo (sender).
 * Adaptive paging: start big (indexed-arg filters are sparse), halve the page on "range too large" (or a
 * persistent `UNKNOWN` — some providers reject an oversized range with a code/message we don't recognise)
 * and retry the whole page at the smaller size, grow the page back on success. A rate-limit error retries
 * just the one failing call in place (same range) with linear backoff, so an intermittent 429 doesn't force
 * re-fetching calls that already succeeded, and gives up (without halving) once its own retry budget is
 * exhausted. An exhausted `UNKNOWN`/`RPC_RANGE_TOO_LARGE` only gives up once the page is already at its
 * floor and still fails. Any other code (`RPC_FORBIDDEN`, `RPC_HISTORY_UNAVAILABLE`, …) is not retryable
 * and fails fast, carrying that code and its `nextStep` — it is never mistaken for a halvable range error.
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
      if (page < max) page = page * 2n > max ? max : page * 2n;
    } catch (e) {
      if (!(e instanceof FetchGiveUp)) throw e;
      const { ledger } = e;
      const halvable = ledger.code === 'RPC_RANGE_TOO_LARGE' || ledger.code === 'UNKNOWN';
      if (halvable && page > min) {
        page = page / 2n < min ? min : page / 2n;
        continue;
      }
      throw new Error(
        `fetchAddressLogs failed at block ${from}: ${ledger.code} — ${ledger.message} ${ledger.nextStep}${detailSuffix(ledger)}`,
      );
    }
  }
  return out;
}
