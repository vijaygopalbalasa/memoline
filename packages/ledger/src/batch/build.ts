import { type Address, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { memoAbi } from '../chain/abis/memo.js';
import { multicall3FromAbi } from '../chain/abis/multicall3From.js';
import type { Chunk, PayoutRow } from './chunk.js';

export type Call3 = { target: Address; allowFailure: boolean; callData: Hex };

export function buildTransferCalldata(to: Address, amount6: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount6] });
}

/** One row = Memo.memo(token, transfer(recipient, amount6), memoId, memoData). The Memo event's callDataHash = keccak256(transfer calldata). */
export function buildMemoCall(
  memoAddress: Address,
  token: Address,
  row: PayoutRow,
  allowFailure = false,
): Call3 {
  const inner = buildTransferCalldata(row.recipient, row.amount6);
  return {
    target: memoAddress,
    allowFailure,
    callData: encodeFunctionData({
      abi: memoAbi,
      functionName: 'memo',
      args: [token, inner, row.memoId, row.memoData],
    }),
  };
}

/**
 * Mode A chunk: Multicall3From.aggregate3([...memo calls, feeCall?]).
 * Real sends keep allowFailure=false so a chunk is fully paid or not at all.
 * Pre-flight simulation passes allowFailure=true to collect every row's failure in one eth_call.
 * `feeCall` is the optional trailing fee-row slot (off by default; legal review first).
 */
export function buildChunkCalldata(
  memoAddress: Address,
  token: Address,
  chunk: Chunk,
  opts: { allowFailure?: boolean; feeCall?: Call3 } = {},
): Hex {
  if (chunk.rows.length === 0) throw new Error(`chunk ${chunk.idx} is empty`);
  const calls: Call3[] = chunk.rows.map((r) =>
    buildMemoCall(memoAddress, token, r, opts.allowFailure ?? false),
  );
  if (opts.feeCall) calls.push(opts.feeCall);
  return encodeFunctionData({ abi: multicall3FromAbi, functionName: 'aggregate3', args: [calls] });
}
