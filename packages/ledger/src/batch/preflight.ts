import { type Address, decodeFunctionResult, type PublicClient } from 'viem';
import { multicall3FromAbi } from '../chain/abis/multicall3From.js';
import { type LedgerError, ledgerError, mapRevert, mapRpcError } from '../errors.js';
import { classifySender } from '../wallet/classify.js';
import { buildChunkCalldata } from './build.js';
import type { Chunk } from './chunk.js';

export type PreflightClient = Pick<PublicClient, 'call' | 'estimateGas' | 'getCode'>;
export type PreflightContext = {
  sender: Address;
  memoAddress: Address;
  multicall3From: Address;
  token: Address;
  allow7702: boolean;
};
export type RowPreflight = { rowIndex: number; ok: boolean; error?: LedgerError };
export type PreflightResult = {
  ok: boolean;
  rows: RowPreflight[];
  gasEstimate?: bigint;
  error?: LedgerError;
};

const ZERO = '0x0000000000000000000000000000000000000000';

/** The sender must be an EOA (CallFrom rule). 7702-delegated EOAs are gated by `allow7702`. */
export async function checkSender(
  client: PreflightClient,
  ctx: PreflightContext,
): Promise<LedgerError | null> {
  const kind = classifySender(await client.getCode({ address: ctx.sender }));
  if (kind === 'contract') return ledgerError('SENDER_NOT_EOA');
  if (kind === 'eoa-7702' && !ctx.allow7702) return ledgerError('SENDER_7702_UNSUPPORTED');
  return null;
}

/**
 * Simulates the exact chunk as `aggregate3` with allowFailure=true from the real sender, so every row's
 * success/revert comes back in ONE eth_call. Then estimates gas for the real (allowFailure=false) calldata.
 * Local checks (zero address) run first and are never overridden by the RPC.
 */
export async function preflightChunk(
  client: PreflightClient,
  ctx: PreflightContext,
  chunk: Chunk,
): Promise<PreflightResult> {
  const rows: RowPreflight[] = chunk.rows.map((r) => ({ rowIndex: r.rowIndex, ok: true }));
  const local = new Set<number>();
  chunk.rows.forEach((r, i) => {
    if (r.recipient.toLowerCase() === ZERO) {
      rows[i] = { rowIndex: r.rowIndex, ok: false, error: ledgerError('ZERO_ADDRESS') };
      local.add(i);
    }
  });

  let results: readonly { success: boolean; returnData: `0x${string}` }[];
  try {
    const sim = await client.call({
      account: ctx.sender,
      to: ctx.multicall3From,
      data: buildChunkCalldata(ctx.memoAddress, ctx.token, chunk, { allowFailure: true }),
    });
    if (!sim.data) return { ok: false, rows, error: ledgerError('UNKNOWN', 'empty simulation result') };
    results = decodeFunctionResult({ abi: multicall3FromAbi, functionName: 'aggregate3', data: sim.data });
  } catch (e) {
    return { ok: false, rows, error: mapRpcError(e, { chunkRows: chunk.rows.length }) };
  }
  if (results.length !== chunk.rows.length) {
    return {
      ok: false,
      rows,
      error: ledgerError(
        'UNKNOWN',
        `simulation returned ${results.length} results for ${chunk.rows.length} rows`,
      ),
    };
  }
  results.forEach((res, i) => {
    if (local.has(i) || res.success) return;
    const row = chunk.rows[i];
    if (!row) return;
    rows[i] = {
      rowIndex: row.rowIndex,
      ok: false,
      error: mapRevert(res.returnData, {
        recipient: row.recipient,
        blocklistedHint: res.returnData === '0x',
      }),
    };
  });
  if (rows.some((r) => !r.ok)) return { ok: false, rows };

  try {
    const gasEstimate = await client.estimateGas({
      account: ctx.sender,
      to: ctx.multicall3From,
      data: buildChunkCalldata(ctx.memoAddress, ctx.token, chunk),
    });
    return { ok: true, rows, gasEstimate };
  } catch (e) {
    return { ok: false, rows, error: mapRpcError(e, { chunkRows: chunk.rows.length }) };
  }
}
