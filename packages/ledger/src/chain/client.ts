import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import type { ChainId } from './addresses.js';
import { chainById } from './chains.js';

export type ClientOptions = {
  chainId: ChainId;
  primaryUrl: string;
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
