import type { PublicClient } from 'viem';
import { ADDRESSES, type ChainId, REQUIRED_CONTRACTS } from './addresses.js';

/** Refuse to run if any required contract has no bytecode on this chain. */
export async function assertContractsDeployed(
  client: Pick<PublicClient, 'getCode'>,
  chainId: ChainId,
): Promise<void> {
  const checks = await Promise.all(
    REQUIRED_CONTRACTS.map(async (key) => {
      const { address } = ADDRESSES[chainId][key];
      const code = await client.getCode({ address });
      const deployed = Boolean(code) && code !== '0x';
      return { key, address, deployed };
    }),
  );
  const missing = checks
    .filter((c) => !c.deployed)
    .map((c) => `${c.key === 'memo' ? 'Memo' : c.key} @ ${c.address}`);
  if (missing.length) throw new Error(`Contracts not deployed on chain ${chainId}: ${missing.join(', ')}`);
}
