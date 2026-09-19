import type { PublicClient } from 'viem';
import { ADDRESSES, type ChainId, REQUIRED_CONTRACTS } from './addresses.js';

/** Refuse to run if any required contract has no bytecode on this chain. */
export async function assertContractsDeployed(
  client: Pick<PublicClient, 'getCode'>,
  chainId: ChainId,
): Promise<void> {
  const missing: string[] = [];
  for (const key of REQUIRED_CONTRACTS) {
    const { address } = ADDRESSES[chainId][key];
    const code = await client.getCode({ address });
    if (!code || code === '0x') missing.push(`${key === 'memo' ? 'Memo' : key} @ ${address}`);
  }
  if (missing.length) throw new Error(`Contracts not deployed on chain ${chainId}: ${missing.join(', ')}`);
}
