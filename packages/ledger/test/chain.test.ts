import { getAddress, toEventSelector, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ADDRESSES,
  assertContractsDeployed,
  chainById,
  clampMaxFeePerGas,
  computeFeeNative18,
  FEE,
  memoAbi,
  multicall3FromAbi,
  TOPICS,
} from '../src/index.js';

describe('chain constants', () => {
  it('has both networks with checksummed addresses and sources', () => {
    for (const id of [5042, 5042002] as const) {
      for (const [key, entry] of Object.entries(ADDRESSES[id])) {
        expect(getAddress(entry.address), key).toBe(entry.address);
        expect(entry.source, key).toMatch(/^https:\/\//);
        expect(entry.checked, key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    expect(ADDRESSES[5042].usdc.address).toBe('0x3600000000000000000000000000000000000000');
    expect(ADDRESSES[5042002].eurc.address).toBe('0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a');
    expect(ADDRESSES[5042].eurc.address).toBe('0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1');
  });

  it('topics match the documented hashes', () => {
    expect(TOPICS.memo).toBe('0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4');
    expect(TOPICS.transfer).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
    // Independently computed via `cast keccak "BeforeMemo(uint256)"`, not derived from toEventSelector.
    expect(TOPICS.beforeMemo).toBe('0xb252e055da754c72fbf7542cf424b190808a9b541e912894c5e15b4238c41501');
  });

  it('ABIs expose the verified selectors', () => {
    expect(toFunctionSelector('aggregate3((address,bool,bytes)[])')).toBe('0x82ad56cb');
    const agg = multicall3FromAbi.find((f) => f.type === 'function' && f.name === 'aggregate3');
    if (!agg) throw new Error('aggregate3 not found in multicall3FromAbi');
    expect(toFunctionSelector(agg)).toBe('0x82ad56cb');

    expect(toFunctionSelector('memo(address,bytes,bytes32,bytes)')).toBe('0xc3b2c4f8');
    const memoFn = memoAbi.find(
      (f): f is Extract<(typeof memoAbi)[number], { type: 'function' }> =>
        f.type === 'function' && f.name === 'memo',
    );
    if (!memoFn) throw new Error('memo not found in memoAbi');
    expect(toFunctionSelector(memoFn)).toBe('0xc3b2c4f8');

    const memoEvent = memoAbi.find(
      (e): e is Extract<(typeof memoAbi)[number], { type: 'event'; name: 'Memo' }> =>
        e.type === 'event' && e.name === 'Memo',
    );
    if (!memoEvent) throw new Error('Memo event not found in memoAbi');
    expect(toEventSelector(memoEvent)).toBe(TOPICS.memo);

    const beforeMemoEvent = memoAbi.find(
      (e): e is Extract<(typeof memoAbi)[number], { type: 'event'; name: 'BeforeMemo' }> =>
        e.type === 'event' && e.name === 'BeforeMemo',
    );
    if (!beforeMemoEvent) throw new Error('BeforeMemo event not found in memoAbi');
    expect(toEventSelector(beforeMemoEvent)).toBe(TOPICS.beforeMemo);
  });

  it('clamps fees to the 20 Gwei floor', () => {
    expect(clampMaxFeePerGas(1n)).toBe(FEE.minMaxFeePerGasWei);
    expect(clampMaxFeePerGas(25_000_000_000n)).toBe(25_000_000_000n);
    expect(FEE.txGasCap).toBe(16_777_216n);
    expect(computeFeeNative18(21_000n, 20_000_000_000n)).toBe(420_000_000_000_000n);
  });

  it('chainById returns viem chains with our RPC overrides', () => {
    expect(chainById(5042).id).toBe(5042);
    expect(chainById(5042002).rpcUrls.default.http[0]).toBe('https://rpc.testnet.arc.io');
    expect(chainById(5042).blockExplorers?.default.url).toBe('https://explorer.arc.io');
  });

  it('assertContractsDeployed refuses when a contract has no code', async () => {
    const ok = { getCode: async () => '0x6000' as const } as unknown as Parameters<
      typeof assertContractsDeployed
    >[0];
    await expect(assertContractsDeployed(ok, 5042002)).resolves.toBeUndefined();
    const bad = {
      getCode: async ({ address }: { address: string }) =>
        address.toLowerCase() === ADDRESSES[5042002].memo.address.toLowerCase() ? undefined : '0x6000',
    } as unknown as Parameters<typeof assertContractsDeployed>[0];
    await expect(assertContractsDeployed(bad, 5042002)).rejects.toThrow(/Memo/);
  });
});
