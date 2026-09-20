import { type Address, encodeAbiParameters, encodeErrorResult, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { ADDRESSES, checkSender, makePayoutRow, type PreflightClient, preflightChunk } from '../src/index.js';

const A = ADDRESSES[5042002];
const ctx = {
  sender: '0x427C62eDCae20DDc8c5e875De39D4E4845491458' as Address,
  memoAddress: A.memo.address,
  multicall3From: A.multicall3From.address,
  token: A.usdc.address,
  allow7702: false,
};
const R1 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const errorAbi = [{ type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] }] as const;
/** Real on-chain returnData from Spike 0 test 6b (Arc Testnet): MemoFailed(bytes) (selector 0xed1966a2,
 * circlefin/arc-node IMemo.sol) wrapping Error("Blocked address") for a blocklisted recipient. */
const REAL_MEMO_FAILED_BLOCKLISTED: Hex =
  '0xed1966a20000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000006408c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000f426c6f636b65642061646472657373000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

function resultsHex(items: { success: boolean; returnData: Hex }[]): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
    [items],
  );
}
function client(o: {
  results?: { success: boolean; returnData: Hex }[];
  callThrows?: unknown;
  gas?: bigint;
  gasThrows?: unknown;
  code?: Hex;
}): PreflightClient {
  return {
    call: async () => {
      if (o.callThrows) throw o.callThrows;
      return { data: resultsHex(o.results ?? []) };
    },
    estimateGas: async () => {
      if (o.gasThrows) throw o.gasThrows;
      return o.gas ?? 100_000n;
    },
    getCode: async () => o.code ?? '0x',
  } as unknown as PreflightClient;
}

describe('preflightChunk', () => {
  const rows = [
    makePayoutRow('RUN', 0, R1, 5n, 'a'),
    makePayoutRow('RUN', 1, A.blocklistedTest.address, 5n, 'b'),
  ];

  it('marks each row from the simulated aggregate3 results and estimates gas only when all pass', async () => {
    const c = client({
      results: [
        { success: true, returnData: '0x' },
        {
          success: false,
          returnData: encodeErrorResult({ abi: errorAbi, errorName: 'Error', args: ['blocklisted'] }),
        },
      ],
    });
    const r = await preflightChunk(c, ctx, { idx: 0, rows });
    expect(r.ok).toBe(false);
    expect(r.rows[0]).toEqual({ rowIndex: 0, ok: true });
    expect(r.rows[1]?.error?.code).toBe('BLOCKLISTED');
    expect(r.gasEstimate).toBeUndefined();
  });

  it('unwraps the real on-chain MemoFailed(bytes) revert on a failing row to BLOCKLISTED', async () => {
    const c = client({
      results: [
        { success: true, returnData: '0x' },
        { success: false, returnData: REAL_MEMO_FAILED_BLOCKLISTED },
      ],
    });
    const r = await preflightChunk(c, ctx, { idx: 0, rows });
    expect(r.ok).toBe(false);
    expect(r.rows[1]?.error?.code).toBe('BLOCKLISTED');
  });

  it('returns ok with a gas estimate when every row passes', async () => {
    const c = client({
      results: [
        { success: true, returnData: '0x' },
        { success: true, returnData: '0x' },
      ],
      gas: 250_000n,
    });
    const r = await preflightChunk(c, ctx, { idx: 0, rows });
    expect(r.ok).toBe(true);
    expect(r.gasEstimate).toBe(250_000n);
  });

  it('flags zero-address rows locally without trusting the RPC (false-positive guard)', async () => {
    const zero = makePayoutRow('RUN', 0, '0x0000000000000000000000000000000000000000', 5n, 'z');
    const c = client({ results: [{ success: true, returnData: '0x' }] }); // RPC lies: says success
    const r = await preflightChunk(c, ctx, { idx: 0, rows: [zero] });
    expect(r.rows[0]?.error?.code).toBe('ZERO_ADDRESS');
    expect(r.ok).toBe(false);
  });

  it('treats a result-count mismatch as a chunk-level error, not as success', async () => {
    const c = client({ results: [{ success: true, returnData: '0x' }] });
    const r = await preflightChunk(c, ctx, { idx: 0, rows });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNKNOWN');
  });

  it('maps a whole-call RPC failure (429) to a chunk-level error', async () => {
    const c = client({ callThrows: { status: 429, message: 'Too Many Requests' } });
    const r = await preflightChunk(c, ctx, { idx: 0, rows });
    expect(r.error?.code).toBe('RPC_RATE_LIMITED');
  });

  it('maps estimateGas -32003 on a big chunk to GAS_CAP_EXCEEDED', async () => {
    const big = Array.from({ length: 80 }, (_, i) => makePayoutRow('RUN', i, R1, 1n, 'x'));
    const c = client({
      results: big.map(() => ({ success: true, returnData: '0x' })),
      gasThrows: { code: -32003, message: 'out of gas' },
    });
    const r = await preflightChunk(c, ctx, { idx: 0, rows: big });
    expect(r.error?.code).toBe('GAS_CAP_EXCEEDED');
  });
});

describe('checkSender', () => {
  it('allows EOA, blocks contracts, gates 7702 by flag', async () => {
    expect(await checkSender(client({ code: '0x' }), ctx)).toBeNull();
    expect((await checkSender(client({ code: '0x6080' }), ctx))?.code).toBe('SENDER_NOT_EOA');
    const d = '0xef0100000000000000000000000000000000000000cafe' as Hex;
    expect((await checkSender(client({ code: d }), ctx))?.code).toBe('SENDER_7702_UNSUPPORTED');
    expect(await checkSender(client({ code: d }), { ...ctx, allow7702: true })).toBeNull();
  });
});
