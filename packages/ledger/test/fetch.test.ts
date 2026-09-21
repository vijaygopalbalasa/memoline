import type { Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { ADDRESSES, type FetchClient, fetchAddressLogs } from '../src/index.js';

type Call = { from: bigint; to: bigint; address: string; eventName: string | undefined; args: unknown };

function mockClient(o: {
  maxRange: bigint;
  failEvery?: number;
  failCode?: number;
  failMessage?: string;
  /** When set, every call throws exactly this, regardless of range or `failEvery`. */
  alwaysThrow?: unknown;
}): {
  client: FetchClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  let n = 0;
  const client = {
    getLogs: async (p: {
      fromBlock: bigint;
      toBlock: bigint;
      address?: string;
      event?: { name?: string };
      args?: unknown;
    }) => {
      n++;
      calls.push({
        from: p.fromBlock,
        to: p.toBlock,
        address: String(p.address ?? '').toLowerCase(),
        eventName: p.event?.name,
        args: p.args,
      });
      if (o.alwaysThrow !== undefined) throw o.alwaysThrow;
      if (o.failEvery && n % o.failEvery === 0) throw { status: 429, message: 'Too Many Requests' };
      if (p.toBlock - p.fromBlock + 1n > o.maxRange) {
        throw { code: o.failCode ?? -32602, message: o.failMessage ?? 'request exceeded max allowed range' };
      }
      return [];
    },
  } as unknown as FetchClient;
  return { client, calls };
}

const CHAIN = 5042002 as const;
const TARGET = '0x427C62eDCae20DDc8c5e875De39D4E4845491458';
const SYSTEM_EMITTER = ADDRESSES[CHAIN].systemEmitter.address.toLowerCase();
const EURC = ADDRESSES[CHAIN].eurc.address.toLowerCase();
const MEMO = ADDRESSES[CHAIN].memo.address.toLowerCase();

function shapeKey(c: { address: string; eventName: string | undefined; args: unknown }): string {
  return `${c.address}|${c.eventName}|${JSON.stringify(c.args)}`;
}

/** The exact five queries `fetchAddressLogs` must issue, once each, per page. */
function expectedShapeKeys(address: string): string[] {
  return [
    shapeKey({ address: SYSTEM_EMITTER, eventName: 'Transfer', args: { from: address } }),
    shapeKey({ address: SYSTEM_EMITTER, eventName: 'Transfer', args: { to: address } }),
    shapeKey({ address: EURC, eventName: 'Transfer', args: { from: address } }),
    shapeKey({ address: EURC, eventName: 'Transfer', args: { to: address } }),
    shapeKey({ address: MEMO, eventName: 'Memo', args: { sender: address } }),
  ].sort();
}

/**
 * Groups the successfully-ranged calls (`to - from + 1 <= maxRange`) by `(from,to)`. For each group,
 * asserts it contains exactly the five expected query shapes, exactly once each — this both confirms
 * the query set (address/event/args) and restores overlap detection that a naive Map-based dedupe
 * would hide (a bug that issued a query twice, or skipped one, changes the count away from 5).
 * Returns the covered ranges, sorted by `from`, for a contiguity/coverage check.
 */
function assertFiveQueriesPerPage(
  calls: Call[],
  maxRange: bigint,
  address: string,
): { from: bigint; to: bigint }[] {
  const successful = calls.filter((c) => c.to - c.from + 1n <= maxRange);
  const byKey = new Map<string, { from: bigint; to: bigint; group: Call[] }>();
  for (const c of successful) {
    const key = `${c.from}-${c.to}`;
    const entry = byKey.get(key) ?? { from: c.from, to: c.to, group: [] };
    entry.group.push(c);
    byKey.set(key, entry);
  }
  // `args` carries the address exactly as fetchAddressLogs was called with it (not lowercased —
  // that's what the real code sends), while the query `address` (the contract being filtered) is
  // compared case-insensitively since ADDRESSES stores checksummed addresses.
  const expected = expectedShapeKeys(address);
  const ranges: { from: bigint; to: bigint }[] = [];
  for (const [key, entry] of byKey) {
    expect(entry.group, `page ${key} call count`).toHaveLength(5);
    expect(entry.group.map(shapeKey).sort(), `page ${key} query shapes`).toEqual(expected);
    ranges.push({ from: entry.from, to: entry.to });
  }
  return ranges.sort((a, b) => (a.from < b.from ? -1 : 1));
}

function assertContiguousCoverage(
  ranges: { from: bigint; to: bigint }[],
  fromBlock: bigint,
  toBlock: bigint,
) {
  expect(ranges[0]?.from).toBe(fromBlock);
  expect(ranges[ranges.length - 1]?.to).toBe(toBlock);
  for (let i = 1; i < ranges.length; i++) {
    const cur = ranges[i];
    const prev = ranges[i - 1];
    if (!cur || !prev) throw new Error('unexpected hole in ranges[]');
    expect(cur.from).toBe(prev.to + 1n);
  }
}

describe('fetchAddressLogs adaptive paging', () => {
  it('halves the page on range errors, covers the whole span without gaps or overlap, and issues exactly the five expected queries per page', async () => {
    const { client, calls } = mockClient({ maxRange: 30_000n });
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 1_000n,
      toBlock: 120_999n,
      sleepMs: 0,
    });
    const ranges = assertFiveQueriesPerPage(calls, 30_000n, TARGET);
    assertContiguousCoverage(ranges, 1_000n, 120_999n);
    expect(result.complete).toBe(true);
    expect(result.scannedToBlock).toBe(120_999n);
  });

  it('falls back to page halving on a persistent UNKNOWN error (a provider-specific "range too large" the mapper does not recognise) and still completes with contiguous coverage', async () => {
    const { client, calls } = mockClient({
      maxRange: 30_000n,
      failCode: -32600,
      failMessage: 'response size exceeded',
    });
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 1_000n,
      toBlock: 120_999n,
      sleepMs: 0,
    });
    const ranges = assertFiveQueriesPerPage(calls, 30_000n, TARGET);
    assertContiguousCoverage(ranges, 1_000n, 120_999n);
    expect(result.complete).toBe(true);
    expect(result.scannedToBlock).toBe(120_999n);
  });

  it('retries on 429 with backoff and still completes', async () => {
    const { client, calls } = mockClient({ maxRange: 10n ** 9n, failEvery: 2 });
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 0n,
      toBlock: 999n,
      sleepMs: 0,
    });
    expect(result.logs).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.scannedToBlock).toBe(999n);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('stops paging when stopWhen trips, returning the pages already collected with complete: false and a correct scannedToBlock', async () => {
    const { client, calls } = mockClient({ maxRange: 30_000n });
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 0n,
      toBlock: 999_999n,
      sleepMs: 0,
      // Page size starts at PARAMS.logPageBlocks.start (200,000) and this mock's maxRange is
      // 30,000, so the very first page halves down before succeeding — stop right after that
      // first successful page, well short of the 999,999 toBlock.
      stopWhen: (p) => p.pages >= 1,
    });
    expect(result.complete).toBe(false);
    expect(result.scannedToBlock).toBeLessThan(999_999n);
    expect(result.scannedToBlock).toBeGreaterThanOrEqual(0n);
    // Every collected page is preserved, not discarded — same five-queries-per-page shape as a
    // full run, just fewer pages.
    const ranges = assertFiveQueriesPerPage(calls, 30_000n, TARGET);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.from).toBe(0n);
    expect(ranges[0]?.to).toBe(result.scannedToBlock);
  });

  it('never trips stopWhen when it always returns false, and still completes with full coverage', async () => {
    const { client } = mockClient({ maxRange: 30_000n });
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 1_000n,
      toBlock: 120_999n,
      sleepMs: 0,
      stopWhen: () => false,
    });
    expect(result.complete).toBe(true);
    expect(result.scannedToBlock).toBe(120_999n);
  });

  it('gives up immediately on RPC_FORBIDDEN (a Cloudflare 403) without treating it as halvable', async () => {
    const { client, calls } = mockClient({
      maxRange: 10n ** 9n,
      alwaysThrow: { status: 403, message: 'Forbidden' },
    });
    await expect(
      fetchAddressLogs(client, {
        chainId: CHAIN,
        address: TARGET,
        fromBlock: 0n,
        toBlock: 999n,
        sleepMs: 0,
      }),
    ).rejects.toThrow(/RPC_FORBIDDEN/);
    // Not retryable: fails on the very first query, well before a retry loop or a page-size halve
    // could run up the call count.
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it('gives up with RPC_RATE_LIMITED once its own retry budget is exhausted, never halving the page', async () => {
    const { client, calls } = mockClient({
      maxRange: 10n ** 9n,
      alwaysThrow: { status: 429, message: 'Too Many Requests' },
    });
    await expect(
      fetchAddressLogs(client, {
        chainId: CHAIN,
        address: TARGET,
        fromBlock: 0n,
        toBlock: 999n,
        sleepMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/RPC_RATE_LIMITED/);
    // Every retry is in place: all calls share the same (from,to), never a smaller page.
    const uniqueRanges = new Set(calls.map((c) => `${c.from}-${c.to}`));
    expect(uniqueRanges.size).toBe(1);
  });

  it('rejects an inverted range', async () => {
    const { client } = mockClient({ maxRange: 10n });
    await expect(
      fetchAddressLogs(client, {
        chainId: CHAIN,
        address: TARGET,
        fromBlock: 10n,
        toBlock: 5n,
      }),
    ).rejects.toThrow(/range/);
  });
});

describe('fetchAddressLogs backward paging', () => {
  it('pages backward from toBlock to fromBlock in the same adaptively-sized pages, fetched newest-first, covering the whole span without gaps or overlap', async () => {
    const { client, calls } = mockClient({ maxRange: 30_000n });
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 1_000n,
      toBlock: 120_999n,
      sleepMs: 0,
      direction: 'backward',
    });
    const ranges = assertFiveQueriesPerPage(calls, 30_000n, TARGET);
    assertContiguousCoverage(ranges, 1_000n, 120_999n);
    expect(result.complete).toBe(true);
    expect(result.scannedFromBlock).toBe(1_000n);
    expect(result.scannedToBlock).toBe(120_999n);
    // Confirms it actually walked newest-first: every attempt of the very first page (successful or
    // not, since the mock's maxRange forces a few halvings before the first one succeeds) has `to`
    // pinned at the top of the span — a forward scan's first page would instead start at `from: 1_000n`.
    expect(calls[0]?.to).toBe(120_999n);
    const successful = calls.filter((c) => c.to - c.from + 1n <= 30_000n);
    expect(successful[0]?.to).toBe(120_999n);
  });

  it('stops paging backward when stopWhen trips, keeping only the most recent page(s) — the ones nearest toBlock — with complete: false', async () => {
    const { client, calls } = mockClient({ maxRange: 30_000n });
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 0n,
      toBlock: 999_999n,
      sleepMs: 0,
      direction: 'backward',
      // Same rationale as the forward stopWhen test: the first page halves down from
      // PARAMS.logPageBlocks.start (200,000) to fit this mock's 30,000 maxRange, then stops right
      // after that one successful page — well short of covering all the way down to fromBlock.
      stopWhen: (p) => p.pages >= 1,
    });
    expect(result.complete).toBe(false);
    // Backward's fixed end is toBlock — always fully covered once any page has run.
    expect(result.scannedToBlock).toBe(999_999n);
    expect(result.scannedFromBlock).toBeGreaterThan(0n);
    const ranges = assertFiveQueriesPerPage(calls, 30_000n, TARGET);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.to).toBe(999_999n);
    expect(ranges[0]?.from).toBe(result.scannedFromBlock);
  });

  it('returns logs sorted ascending by (blockNumber, logIndex) even though backward paging fetches the newest pages first', async () => {
    const pageLog = (blockNumber: bigint): Log =>
      ({
        blockNumber,
        logIndex: 0,
        transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}`,
        address: '0x0000000000000000000000000000000000000000',
        topics: [],
        data: '0x',
        blockHash: '0x0',
        transactionIndex: 0,
        removed: false,
      }) as unknown as Log;
    // No range errors here (maxRange is effectively unlimited) — the 250,000-block span still forces
    // two pages because it's bigger than a single page's start size (200,000), letting this test stay
    // focused on ordering rather than halving.
    const client: FetchClient = {
      getLogs: async (p: { fromBlock: bigint; toBlock: bigint }) => [pageLog(p.toBlock)],
    } as unknown as FetchClient;
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 0n,
      toBlock: 249_999n,
      sleepMs: 0,
      direction: 'backward',
    });
    expect(result.complete).toBe(true);
    expect(result.scannedFromBlock).toBe(0n);
    expect(result.scannedToBlock).toBe(249_999n);
    const blockNumbers = result.logs.map((l) => l.blockNumber as bigint);
    expect(blockNumbers.length).toBeGreaterThan(0);
    const sorted = [...blockNumbers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(blockNumbers).toEqual(sorted);
  });
});

describe('fetchAddressLogs deadlineAt', () => {
  it('honours deadlineAt inside the retry path — stops before starting another query mid-page, not just between pages, and never sleeps past it', async () => {
    let calls = 0;
    const client: FetchClient = {
      getLogs: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [];
      },
    } as unknown as FetchClient;
    const startedAt = Date.now();
    const result = await fetchAddressLogs(client, {
      chainId: CHAIN,
      address: TARGET,
      fromBlock: 0n,
      toBlock: 999_999n,
      sleepMs: 0,
      // Shorter than a single getLogs call (20ms): the first query (of 5 in the page) is already
      // in flight when the deadline is set, so it's allowed to finish, but the second one must never
      // start.
      deadlineAt: Date.now() + 15,
    });
    const elapsed = Date.now() - startedAt;
    expect(result.complete).toBe(false);
    expect(result.logs).toEqual([]);
    expect(calls).toBe(1);
    // Bounded by ~one in-flight request, not by paging through the 1,000,000-block window (which would
    // need many multi-second RPC round trips against a real provider).
    expect(elapsed).toBeLessThan(200);
  });
});
