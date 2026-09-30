/**
 * The Arc contracts Memoline calls, on mainnet and testnet, and the shape of each call.
 *
 * Addresses: https://docs.arc.io/arc/references/contract-addresses (checked on-chain 2026-09-19).
 * Interfaces: Circle's circlefin/arc-node (Apache-2.0).
 *
 * Public Arc RPCs refuse requests without a User-Agent header, so every client sets one.
 */
import type { Address } from 'viem';

type Network = {
  chainId: number;
  rpc: string;
  explorer: string;
  usdc: Address;
  eurc: Address;
  memo: Address;
  multicall3From: Address;
};

export const ARC = {
  mainnet: {
    chainId: 5042,
    rpc: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    eurc: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    memo: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
    multicall3From: '0x522fAf9A91c41c443c66765030741e4AaCe147D0',
  },
  testnet: {
    chainId: 5042002,
    rpc: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    eurc: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    memo: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
    multicall3From: '0x522fAf9A91c41c443c66765030741e4AaCe147D0',
  },
} as const satisfies Record<'mainnet' | 'testnet', Network>;

/**
 * Memo.memo(target, data, memoId, memoData) makes the call `data` to `target` as the original sender,
 * then emits a Memo event with the hash of that call and the reference, so the two can be matched.
 */
export const memoAbi = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Memo',
    anonymous: false,
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'target', type: 'address', indexed: true },
      { name: 'callDataHash', type: 'bytes32', indexed: false },
      { name: 'memoId', type: 'bytes32', indexed: true },
      { name: 'memo', type: 'bytes', indexed: false },
      { name: 'memoIndex', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * Multicall3From.aggregate3 is the standard Multicall3 call, except that every call keeps the original
 * sender (through Arc's CallFrom precompile). That is what lets a plain wallet pay a whole list in one
 * transaction while each transfer still comes from that wallet.
 */
export const multicall3FromAbi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;
