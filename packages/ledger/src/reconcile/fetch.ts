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
  /**
   * Which end of `[fromBlock, toBlock]` paging starts from. `'forward'` (the default — unchanged
   * behaviour for the stored/cron import) starts at `fromBlock` and walks up; the fixed end of the
   * covered range is always `fromBlock`, and `scannedToBlock` grows toward `toBlock` as pages
   * complete. `'backward'` starts at `toBlock` and walks down; the fixed end is always `toBlock`, and
   * `scannedFromBlock` shrinks toward `fromBlock` as pages complete. This matters when the scan can be
   * cut short (`stopWhen` or `deadlineAt`): forward returns the oldest slice of the window, backward
   * returns the newest — the one that matters for "paste an address, see its recent movements".
   */
  direction?: 'forward' | 'backward';
  /**
   * Evaluated after each successful page (never mid-page — halving/retries within a page always run
   * to completion first). Returning true stops paging and makes `fetchAddressLogs` return normally
   * with `complete: false`, instead of the caller having to abort via a thrown error that discards
   * every page already collected. `nextFromBlock` is the lower bound of the still-unscanned remainder
   * of `[fromBlock, toBlock]` — for `'forward'` paging that's literally the next page's `fromBlock`
   * query param; for `'backward'` paging the next page starts near the *high* end instead, so this is
   * only the range's low edge, not the next query's own param.
   */
  stopWhen?: (p: { elapsedMs: number; pages: number; logs: number; nextFromBlock: bigint }) => boolean;
  /**
   * Hard wall-clock deadline (epoch ms, e.g. `Date.now() + budget`). Unlike `stopWhen` — which is only
   * checked between completed pages — this is checked *inside* the retry path: before every query
   * attempt (the first try of each of the 5 per-page queries, and every retry of one) and before every
   * backoff sleep, which is also capped so it never sleeps past the deadline. Once it has passed, no
   * further queries or sleeps happen and `fetchAddressLogs` returns immediately with whatever full
   * pages were already collected and `complete: false` — a page already in flight when the deadline
   * hits is never partially committed.
   */
  deadlineAt?: number;
  sleepMs?: number;
  maxAttempts?: number;
};
export type FetchResult = {
  logs: Log[];
  /** The lowest block actually covered by a completed page. Equals `fromBlock` when `complete`
   * (always true for `'forward'`, which covers `fromBlock` from its very first page). */
  scannedFromBlock: bigint;
  /** The highest block actually covered by a completed page. Equals `toBlock` when `complete`
   * (always true for `'backward'`, which covers `toBlock` from its very first page). */
  scannedToBlock: bigint;
  /** Whether paging covered the whole `[fromBlock, toBlock]` span (false when `stopWhen` or
   * `deadlineAt` cut it short). */
  complete: boolean;
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

/** Thrown by `callWithRetry` (and the `boundedSleep` it uses for backoff) the moment `deadlineAt` has
 * passed — before starting another query attempt and before sleeping past it. Caught one level up, in
 * `fetchAddressLogs`'s per-page loop, where it means "stop now, keep only the pages already committed"
 * rather than a real RPC failure the caller should see. */
class DeadlineExceeded extends Error {
  constructor() {
    super('deadline exceeded');
    this.name = 'DeadlineExceeded';
  }
}

/** The raw provider text (`LedgerError.detail`), when present, appended to a give-up message — the
 * generic per-code message ("The RPC rejected the log query as too large") is the same for every
 * provider, but the detail is what actually tells you which provider and why (e.g. dRPC's
 * "ranges over 10000 blocks are not supported on free plan", which understates its own real cap). */
function detailSuffix(ledger: LedgerError): string {
  return ledger.detail === undefined ? '' : ` (provider said: ${String(ledger.detail)})`;
}

function deadlinePassed(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

/** `sleep`, but capped so it never runs past `deadlineAt` — if the deadline has already passed (or
 * would pass before `ms` elapses), it sleeps only the remainder, and if none is left it throws
 * `DeadlineExceeded` immediately instead of sleeping 0ms and looping back around. */
async function boundedSleep(ms: number, deadlineAt: number | undefined): Promise<void> {
  if (deadlineAt === undefined) return sleep(ms);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new DeadlineExceeded();
  await sleep(Math.min(ms, remaining));
}

/** Sorts by (blockNumber, logIndex) ascending, independent of the order pages were fetched in — so a
 * `'backward'` scan (which fetches newest-first) still hands reconciliation logs in the same order a
 * `'forward'` one always did. */
function sortLogs(logs: Log[]): Log[] {
  return [...logs].sort((x, y) => {
    const xb = x.blockNumber ?? 0n;
    const yb = y.blockNumber ?? 0n;
    if (xb !== yb) return xb < yb ? -1 : 1;
    return (x.logIndex ?? 0) - (y.logIndex ?? 0);
  });
}

/**
 * Retries one `getLogs` call in place (same block range) with linear backoff on rate limiting.
 * `RPC_RANGE_TOO_LARGE` is never retried here — it means the range itself must shrink, which is a
 * page-level decision the caller makes (it affects all 5 queries for this page, not just this one).
 * `UNKNOWN` gets a few in-place attempts, then gives up so the caller can fall back to page halving the
 * same way it does for an explicit range-too-large error. Every other code (`RPC_FORBIDDEN`,
 * `RPC_HISTORY_UNAVAILABLE`, …) is not retryable and gives up immediately on the first attempt.
 *
 * `deadlineAt`, when set, is checked before every attempt (including the first) and bounds every
 * backoff sleep — see `DeadlineExceeded` / `boundedSleep`.
 */
async function callWithRetry(
  fn: () => Promise<readonly Log[]>,
  maxAttempts: number,
  sleepMs: number,
  deadlineAt: number | undefined,
): Promise<readonly Log[]> {
  let rateAttempts = 0;
  let unknownAttempts = 0;
  for (;;) {
    if (deadlinePassed(deadlineAt)) throw new DeadlineExceeded();
    try {
      return await fn();
    } catch (e) {
      const err = mapRpcError(e);
      if (err.code === 'RPC_RANGE_TOO_LARGE') throw new FetchGiveUp(err);
      if (err.code === 'UNKNOWN') {
        unknownAttempts++;
        if (unknownAttempts > UNKNOWN_INPLACE_RETRIES) throw new FetchGiveUp(err);
        await boundedSleep(sleepMs * unknownAttempts, deadlineAt);
        continue;
      }
      if (err.code === 'RPC_RATE_LIMITED') {
        rateAttempts++;
        if (rateAttempts > maxAttempts) throw new FetchGiveUp(err);
        await boundedSleep(
          Math.min(sleepMs * RATE_LIMIT_BACKOFF_MULTIPLIER * rateAttempts, RATE_LIMIT_BACKOFF_CAP_MS),
          deadlineAt,
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
 * Adaptive paging: start at the largest range Arc's history providers accept (`PARAMS.logPageBlocks`), halve the page on "range too large" (or a
 * persistent `UNKNOWN` — some providers reject an oversized range with a code/message we don't recognise)
 * and retry the whole page at the smaller size, grow the page back on success. A rate-limit error retries
 * just the one failing call in place (same range) with linear backoff, so an intermittent 429 doesn't force
 * re-fetching calls that already succeeded, and gives up (without halving) once its own retry budget is
 * exhausted. An exhausted `UNKNOWN`/`RPC_RANGE_TOO_LARGE` only gives up once the page is already at its
 * floor and still fails. Any other code (`RPC_FORBIDDEN`, `RPC_HISTORY_UNAVAILABLE`, …) is not retryable
 * and fails fast, carrying that code and its `nextStep` — it is never mistaken for a halvable range error.
 *
 * Pages walk from `fromBlock` up (`direction: 'forward'`, the default) or from `toBlock` down
 * (`'backward'`) in the same adaptively-sized pages either way; see `FetchOptions.direction`.
 *
 * Returns `{ logs, scannedFromBlock, scannedToBlock, complete }` rather than a bare array so a caller
 * with `stopWhen` or `deadlineAt` (e.g. a deadline or a log-count ceiling) gets back everything collected
 * up to that point instead of having to throw and lose it — `complete` tells them whether the whole span
 * was actually reached. Logs are always returned sorted ascending by (blockNumber, logIndex), regardless
 * of `direction`, so downstream reconciliation never has to care which way the scan walked.
 */
export async function fetchAddressLogs(client: FetchClient, o: FetchOptions): Promise<FetchResult> {
  const a = ADDRESSES[o.chainId];
  return pageBlockRange(o, async (from, to, retry) => {
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
    const pageLogs: Log[] = [];
    for (const q of [q1, q2, q3, q4, q5]) pageLogs.push(...((await retry(q)) as Log[]));
    return pageLogs;
  });
}

export type PagedLogsOptions = Pick<
  FetchOptions,
  'fromBlock' | 'toBlock' | 'direction' | 'stopWhen' | 'deadlineAt' | 'sleepMs' | 'maxAttempts' | 'onPage'
>;

/**
 * One arbitrary `getLogs` filter, walked over `[fromBlock, toBlock]` with the same adaptive paging,
 * retry and deadline engine as `fetchAddressLogs`. For callers that need a log query over a span that
 * can outgrow a provider's range cap but isn't an address history — e.g. the run-side "did this
 * chunk's memoIds already land?" check, which scans from the run's start block to the head and so
 * grows past 10,000 blocks (~83 minutes of Arc at 0.5 s blocks) for any run left open that long.
 * `filter` is everything except the block bounds, which the pager supplies per page.
 */
export async function getLogsPaged(
  client: FetchClient,
  filter: Omit<Parameters<FetchClient['getLogs']>[0], 'fromBlock' | 'toBlock' | 'blockHash'>,
  o: PagedLogsOptions,
): Promise<FetchResult> {
  return pageBlockRange(o, async (from, to, retry) => {
    // The cast keeps viem's event/args overload pairing intact: the caller built `filter` against a
    // concrete event, and re-spreading it with block bounds must not widen it to the untyped branch.
    const logs = await retry(() =>
      client.getLogs({ ...filter, fromBlock: from, toBlock: to } as Parameters<FetchClient['getLogs']>[0]),
    );
    return logs as Log[];
  });
}

type PageFetcher = (
  from: bigint,
  to: bigint,
  retry: (fn: () => Promise<readonly Log[]>) => Promise<readonly Log[]>,
) => Promise<Log[]>;

/**
 * The paging engine behind `fetchAddressLogs` and `getLogsPaged`: walks `[fromBlock, toBlock]` in
 * adaptively-sized pages, calling `fetchPage(from, to, retry)` for each one. `retry` is the in-place
 * retry wrapper (`callWithRetry`) the page function must route every RPC call through, so a rate limit
 * on one call retries just that call and a range rejection escalates to a page halve for the whole page.
 *
 * Page sizing: start at `PARAMS.logPageBlocks.start`, halve on a range rejection (or an `UNKNOWN`
 * that outlasted its in-place retries), and grow back on success only until the first rejection —
 * after that `ceiling` pins growth at the halved size that then worked. Without that memory the
 * pager oscillates: every success doubles the page straight back into the size that just failed,
 * costing a rejected call (and a wasted round trip on a rate-limited endpoint) for every page it
 * fetches. Settling at the first size that works, rather than binary-searching for the provider's
 * exact cap, trades at most ~2× more pages for zero further rejections.
 *
 * Deadline/stop semantics, `scannedFromBlock`/`scannedToBlock`, direction and the sorted result are
 * exactly as documented on `FetchOptions`/`FetchResult`.
 */
async function pageBlockRange(o: PagedLogsOptions, fetchPage: PageFetcher): Promise<FetchResult> {
  if (o.fromBlock > o.toBlock) throw new Error(`invalid block range ${o.fromBlock}..${o.toBlock}`);
  const out: Log[] = [];
  let page = BigInt(PARAMS.logPageBlocks.start);
  const min = BigInt(PARAMS.logPageBlocks.min);
  const max = BigInt(PARAMS.logPageBlocks.max);
  // Growth cap: `max` until a provider rejects a page, then the halved size that replaced it.
  let ceiling = max;
  const maxAttempts = o.maxAttempts ?? 12;
  const sleepMs = o.sleepMs ?? 500;
  const deadlineAt = o.deadlineAt;
  const direction = o.direction ?? 'forward';
  const start = Date.now();
  let pages = 0;
  const retry = (fn: () => Promise<readonly Log[]>) => callWithRetry(fn, maxAttempts, sleepMs, deadlineAt);

  // [lo, hi] is the still-unscanned remainder of [fromBlock, toBlock]. Forward paging only ever moves
  // `lo` up (`hi` stays `toBlock`); backward only ever moves `hi` down (`lo` stays `fromBlock`). Either
  // way, `lo > hi` means the whole span has been covered — direction-agnostic completion check.
  let lo = o.fromBlock;
  let hi = o.toBlock;
  let scannedFromBlock = direction === 'forward' ? o.fromBlock : o.toBlock;
  let scannedToBlock = direction === 'forward' ? o.fromBlock : o.toBlock;

  const finish = (complete: boolean): FetchResult => ({
    logs: sortLogs(out),
    scannedFromBlock,
    scannedToBlock,
    complete,
  });

  while (lo <= hi) {
    const from = direction === 'forward' ? lo : hi - page + 1n < lo ? lo : hi - page + 1n;
    const to = direction === 'forward' ? (lo + page - 1n > hi ? hi : lo + page - 1n) : hi;
    try {
      const pageLogs = await fetchPage(from, to, retry);
      out.push(...pageLogs);
      o.onPage?.({ from, to, logs: pageLogs.length });
      pages++;
      if (direction === 'forward') {
        scannedToBlock = to;
        lo = to + 1n;
      } else {
        scannedFromBlock = from;
        hi = from - 1n;
      }
      const cap = ceiling < max ? ceiling : max;
      if (page < cap) page = page * 2n > cap ? cap : page * 2n;
      if (o.stopWhen?.({ elapsedMs: Date.now() - start, pages, logs: out.length, nextFromBlock: lo })) {
        return finish(lo > hi);
      }
    } catch (e) {
      if (e instanceof DeadlineExceeded) return finish(false);
      if (!(e instanceof FetchGiveUp)) throw e;
      const { ledger } = e;
      const halvable = ledger.code === 'RPC_RANGE_TOO_LARGE' || ledger.code === 'UNKNOWN';
      if (halvable && page > min) {
        page = page / 2n < min ? min : page / 2n;
        ceiling = page;
        continue;
      }
      throw new Error(
        `fetchAddressLogs failed at block ${from}: ${ledger.code} — ${ledger.message} ${ledger.nextStep}${detailSuffix(ledger)}`,
      );
    }
  }
  return finish(true);
}
