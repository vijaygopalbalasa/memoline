import type { Address } from 'viem';

export type ChainId = 5042 | 5042002;
export type Sourced = { address: Address; source: string; checked: string };

const DOCS = 'https://docs.arc.io/arc/references/contract-addresses';
const SYS = 'https://docs.arc.io/arc/references/usdc-system-events';
const CHECKED = '2026-09-19';
const s = (address: Address, source = DOCS): Sourced => ({ address, source, checked: CHECKED });

const shared = {
  usdc: s('0x3600000000000000000000000000000000000000'),
  memo: s('0x5294E9927c3306DcBaDb03fe70b92e01cCede505'),
  multicall3From: s('0x522fAf9A91c41c443c66765030741e4AaCe147D0'),
  multicall3: s('0xcA11bde05977b3631167028862bE2a173976CA11'),
  permit2: s('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  systemEmitter: s('0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE', SYS),
} as const;

export const ADDRESSES = {
  5042: { ...shared, eurc: s('0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1') },
  5042002: {
    ...shared,
    eurc: s('0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'),
    erc8183: s(
      '0x0747EEf0706327138c69792bF28Cd525089e4583',
      'https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job',
    ),
    blocklistedTest: s('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'),
  },
} as const satisfies Record<ChainId, Record<string, Sourced>>;

/** Contracts that must have bytecode at startup. The system emitter is a virtual address (no code) and is exempt. */
export const REQUIRED_CONTRACTS = ['usdc', 'eurc', 'memo', 'multicall3From', 'multicall3'] as const;

export type Token = 'USDC' | 'EURC';
export function tokenAddress(chainId: ChainId, token: Token): Address {
  return token === 'USDC' ? ADDRESSES[chainId].usdc.address : ADDRESSES[chainId].eurc.address;
}
