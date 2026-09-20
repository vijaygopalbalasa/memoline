import { createPublicClient, fallback, http, type PublicClient } from 'viem';
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
  const transports = o.fallbackUrl ? [mk(o.primaryUrl), mk(o.fallbackUrl)] : [mk(o.primaryUrl)];
  return createPublicClient({
    chain: chainById(o.chainId),
    transport: fallback(transports, { rank: false }),
  });
}
