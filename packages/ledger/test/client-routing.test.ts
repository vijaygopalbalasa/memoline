import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeClient } from '../src/index.js';

/** Answers every JSON-RPC call with a canned result and records which host each call went to. */
function stubFetch(answer: (method: string) => unknown) {
  const hosts: { host: string; method: string }[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string };
    hosts.push({ host: new URL(url).host, method: body.method });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer(body.method) }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return hosts;
}

afterEach(() => vi.unstubAllGlobals());

describe('makeClient request routing', () => {
  const opts = {
    chainId: 5042002 as const,
    primaryUrl: 'https://primary.example/v2/key',
    fallbackUrl: 'https://history.example',
    userAgent: 'test',
  };

  it('sends eth_getLogs to the history (fallback) URL first, and everything else to the primary first', async () => {
    const hosts = stubFetch((m) => (m === 'eth_getLogs' ? [] : '0x10'));
    const client = makeClient(opts);
    await client.getBlockNumber();
    await client.getLogs({ fromBlock: 1n, toBlock: 10_000n });
    expect(hosts).toEqual([
      { host: 'primary.example', method: 'eth_blockNumber' },
      { host: 'history.example', method: 'eth_getLogs' },
    ]);
  });

  it('still falls through to the other URL when the first one fails, in both directions', async () => {
    const hosts: { host: string; method: string }[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string };
      const host = new URL(url).host;
      hosts.push({ host, method: body.method });
      // The history URL cannot answer block numbers; the primary cannot answer wide log queries.
      const refuse =
        (host === 'history.example' && body.method === 'eth_blockNumber') ||
        (host === 'primary.example' && body.method === 'eth_getLogs');
      const payload = refuse
        ? { jsonrpc: '2.0', id: body.id, error: { code: -32600, message: 'not here' } }
        : { jsonrpc: '2.0', id: body.id, result: body.method === 'eth_getLogs' ? [] : '0x10' };
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    });
    const client = makeClient({
      ...opts,
      primaryUrl: 'https://history.example',
      fallbackUrl: 'https://primary.example',
    });
    // Primary is now the history host, so block numbers must fall through to the other URL. Log
    // queries are routed to the fallback URL first, which is now the host that refuses them, so
    // they fall through the other way.
    expect(await client.getBlockNumber()).toBe(16n);
    expect(hosts.filter((h) => h.method === 'eth_blockNumber').map((h) => h.host)).toEqual([
      'history.example',
      'primary.example',
    ]);
    await client.getLogs({ fromBlock: 1n, toBlock: 10n });
    expect(hosts.filter((h) => h.method === 'eth_getLogs').map((h) => h.host)).toEqual([
      'primary.example',
      'history.example',
    ]);
  });

  it('with a single URL, every method goes there', async () => {
    const hosts = stubFetch((m) => (m === 'eth_getLogs' ? [] : '0x10'));
    const client = makeClient({ chainId: 5042002, primaryUrl: 'https://only.example', userAgent: 'test' });
    await client.getBlockNumber();
    await client.getLogs({ fromBlock: 1n, toBlock: 10n });
    expect(hosts.map((h) => h.host)).toEqual(['only.example', 'only.example']);
  });
});
