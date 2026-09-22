import { createPublicClient, custom, fallback, http, type PublicClient } from 'viem';
import type { ChainId } from './addresses.js';
import { chainById } from './chains.js';

export type ClientOptions = {
  chainId: ChainId;
  primaryUrl: string;
  /** dRPC's free tier caps eth_getLogs ranges at roughly 100 blocks in practice — its own error
   * message claims a much larger 10,000-block limit, which understates how small the real cap is —
   * so it is unsuitable as a `fallbackUrl` for anything that pages through history
   * (`fetchAddressLogs`). Prefer QuickNode (see `.env.example` / `scripts/testnet/lib.ts`). */
  fallbackUrl?: string;
  /** Public Arc RPCs return Cloudflare 1010 to default programmatic user agents. Always set one. */
  userAgent: string;
  timeoutMs?: number;
};

export function makeClient(o: ClientOptions): PublicClient {
  const mk = (url: string) =>
    http(url, {
      timeout: o.timeoutMs ?? 30_000,
      retryCount: 2,
      retryDelay: 500,
      fetchOptions: { headers: { 'User-Agent': o.userAgent } },
    });
  if (!o.fallbackUrl) {
    return createPublicClient({ chain: chainById(o.chainId), transport: mk(o.primaryUrl) });
  }
  // Two orderings of the same two URLs. Everything goes primary first, except `eth_getLogs`,
  // which goes to the fallback (history) URL first: the keyed primary is fast for calls,
  // receipts and balances, but its free tier caps a log query at 10 blocks (Alchemy on Arc,
  // measured 2026-09-22), so sending every wide log page there first cost a wasted round trip
  // per call before the fallback answered. Both orderings still fall through to the other URL
  // when the first refuses, so a provider outage on either side degrades rather than fails.
  const chain = chainById(o.chainId);
  const primaryFirst = fallback([mk(o.primaryUrl), mk(o.fallbackUrl)], { rank: false })({ chain });
  const historyFirst = fallback([mk(o.fallbackUrl), mk(o.primaryUrl)], { rank: false })({ chain });
  return createPublicClient({
    chain,
    transport: custom({
      request: ({ method, params }) =>
        (method === 'eth_getLogs' ? historyFirst : primaryFirst).request({ method, params }),
    }),
  });
}
