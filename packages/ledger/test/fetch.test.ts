import { describe, expect, it } from 'vitest';
import { type FetchClient, fetchAddressLogs } from '../src/index.js';

function mockClient(o: { maxRange: bigint; failEvery?: number }): {
  client: FetchClient;
  calls: { from: bigint; to: bigint }[];
} {
  const calls: { from: bigint; to: bigint }[] = [];
  let n = 0;
  const client = {
    getLogs: async (p: { fromBlock: bigint; toBlock: bigint }) => {
      n++;
      calls.push({ from: p.fromBlock, to: p.toBlock });
      if (o.failEvery && n % o.failEvery === 0) throw { status: 429, message: 'Too Many Requests' };
      if (p.toBlock - p.fromBlock + 1n > o.maxRange)
        throw { code: -32602, message: 'request exceeded max allowed range' };
      return [];
    },
  } as unknown as FetchClient;
  return { client, calls };
}

describe('fetchAddressLogs adaptive paging', () => {
  it('halves the page on range errors and covers the whole span without gaps or overlap', async () => {
    const { client, calls } = mockClient({ maxRange: 30_000n });
    await fetchAddressLogs(client, {
      chainId: 5042002,
      address: '0x427C62eDCae20DDc8c5e875De39D4E4845491458',
      fromBlock: 1_000n,
      toBlock: 120_999n,
      sleepMs: 0,
    });
    // Each successful page issues 5 getLogs calls sharing the same (from,to); dedupe before
    // checking contiguity so the 5x fan-out doesn't look like an overlap.
    const successful = calls.filter((c) => c.to - c.from + 1n <= 30_000n);
    const dedup = new Map<string, { from: bigint; to: bigint }>();
    for (const c of successful) dedup.set(`${c.from}-${c.to}`, c);
    const ok = [...dedup.values()].sort((a, b) => (a.from < b.from ? -1 : 1));
    expect(ok[0]?.from).toBe(1_000n);
    expect(ok[ok.length - 1]?.to).toBe(120_999n);
    for (let i = 1; i < ok.length; i++) {
      const cur = ok[i];
      const prev = ok[i - 1];
      if (!cur || !prev) throw new Error('unexpected hole in ok[]');
      expect(cur.from).toBe(prev.to + 1n);
    }
  });

  it('retries on 429 with backoff and still completes', async () => {
    const { client, calls } = mockClient({ maxRange: 10n ** 9n, failEvery: 2 });
    const logs = await fetchAddressLogs(client, {
      chainId: 5042002,
      address: '0x427C62eDCae20DDc8c5e875De39D4E4845491458',
      fromBlock: 0n,
      toBlock: 999n,
      sleepMs: 0,
    });
    expect(logs).toEqual([]);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('rejects an inverted range', async () => {
    const { client } = mockClient({ maxRange: 10n });
    await expect(
      fetchAddressLogs(client, {
        chainId: 5042002,
        address: '0x427C62eDCae20DDc8c5e875De39D4E4845491458',
        fromBlock: 10n,
        toBlock: 5n,
      }),
    ).rejects.toThrow(/range/);
  });
});
