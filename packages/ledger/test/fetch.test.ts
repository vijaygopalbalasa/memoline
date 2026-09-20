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
