import { type Chain, defineChain } from 'viem';
import { arc, arcTestnet } from 'viem/chains';
import type { ChainId } from './addresses.js';

export const arcMainnet: Chain = defineChain({
  ...arc,
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
});

export const arcTestnetChain: Chain = defineChain({
  ...arcTestnet,
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Testnet Explorer', url: 'https://explorer.testnet.arc.io' } },
});

export function chainById(chainId: ChainId): Chain {
  return chainId === 5042 ? arcMainnet : arcTestnetChain;
}

export function explorerTxUrl(chainId: ChainId, txHash: string): string {
  return `${chainById(chainId).blockExplorers?.default.url}/tx/${txHash}`;
}
