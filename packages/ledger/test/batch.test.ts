import fc from 'fast-check';
import { type Address, decodeFunctionData, encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ADDRESSES,
  buildChunkCalldata,
  buildMemoCall,
  buildTransferCalldata,
  chunkRows,
  classifySender,
  makePayoutRow,
  memoAbi,
  multicall3FromAbi,
  payoutMemoId,
} from '../src/index.js';

const MEMO = ADDRESSES[5042002].memo.address;
const USDC = ADDRESSES[5042002].usdc.address;
const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;

describe('classifySender', () => {
  it('classifies EOA, EIP-7702 delegated EOA, and contracts', () => {
    expect(classifySender('0x')).toBe('eoa');
    expect(classifySender(undefined)).toBe('eoa');
    expect(classifySender('0xef0100000000000000000000000000000000000000cafe')).toBe('eoa-7702');
    expect(classifySender('0xEF0100000000000000000000000000000000000000CAFE')).toBe('eoa-7702');
    expect(classifySender('0x6080604052')).toBe('contract');
    expect(classifySender('0xef01')).toBe('contract'); // truncated designator is not a valid 7702 code
  });
});

describe('chunkRows', () => {
  it('splits into ceil(n/max) chunks preserving order and indices', () => {
    const rows = Array.from({ length: 120 }, (_, i) => makePayoutRow('R', i, B, 1n, `REF${i}`));
    const chunks = chunkRows(rows, 50);
    expect(chunks.map((c) => c.rows.length)).toEqual([50, 50, 20]);
    expect(chunks.map((c) => c.idx)).toEqual([0, 1, 2]);
    expect(chunks[2]?.rows[0]?.rowIndex).toBe(100);
  });
  it('handles empty input and rejects maxRows < 1', () => {
    expect(chunkRows([], 50)).toEqual([]);
    expect(() => chunkRows([], 0)).toThrow();
  });
  it('never loses or duplicates rows (property)', () => {
    fc.assert(
      fc.property(fc.nat(300), fc.integer({ min: 1, max: 100 }), (n, max) => {
        const rows = Array.from({ length: n }, (_, i) => makePayoutRow('R', i, B, 1n, 'X'));
        const flat = chunkRows(rows, max).flatMap((c) => c.rows.map((r) => r.rowIndex));
        return flat.length === n && flat.every((v, i) => v === i);
      }),
    );
  });
});

describe('calldata building', () => {
  it('buildTransferCalldata equals viem erc20 transfer encoding', () => {
    expect(buildTransferCalldata(A, 125_500_000n)).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [A, 125_500_000n] }),
    );
  });

  it('buildMemoCall wraps transfer in Memo.memo with the row memoId and allowFailure=false by default', () => {
    const row = makePayoutRow('RUN', 3, A, 5n, 'INV-1');
    const call = buildMemoCall(MEMO, USDC, row);
    expect(call.target).toBe(MEMO);
    expect(call.allowFailure).toBe(false);
    const d = decodeFunctionData({ abi: memoAbi, data: call.callData });
    expect(d.functionName).toBe('memo');
    expect(d.args[0]).toBe(USDC);
    expect(d.args[1]).toBe(buildTransferCalldata(A, 5n));
    expect(d.args[2]).toBe(payoutMemoId('RUN', 3));
    expect(keccak256(d.args[1])).toBe(keccak256(buildTransferCalldata(A, 5n))); // callDataHash the Memo event will carry
  });

  it('buildChunkCalldata encodes aggregate3 with selector 0x82ad56cb and one call per row', () => {
    const rows = [makePayoutRow('RUN', 0, A, 1n, 'a'), makePayoutRow('RUN', 1, B, 2n, 'b')];
    const data = buildChunkCalldata(MEMO, USDC, { idx: 0, rows });
    expect(data.slice(0, 10)).toBe('0x82ad56cb');
    const d = decodeFunctionData({ abi: multicall3FromAbi, data });
    expect(d.args[0]).toHaveLength(2);
    expect(d.args[0].every((c) => c.target === MEMO && c.allowFailure === false)).toBe(true);
  });

  it('allowFailure=true is only set when explicitly requested (simulation), and feeCall is appended last', () => {
    const rows = [makePayoutRow('RUN', 0, A, 1n, 'a')];
    const fee = { target: USDC, allowFailure: false, callData: buildTransferCalldata(B, 7n) };
    const d = decodeFunctionData({
      abi: multicall3FromAbi,
      data: buildChunkCalldata(MEMO, USDC, { idx: 0, rows }, { allowFailure: true, feeCall: fee }),
    });
    expect(d.args[0]).toHaveLength(2);
    expect(d.args[0][0]?.allowFailure).toBe(true);
    expect(d.args[0][1]).toEqual(fee);
  });

  it('rejects a chunk with zero rows', () => {
    expect(() => buildChunkCalldata(MEMO, USDC, { idx: 0, rows: [] })).toThrow(/empty/);
  });
});
