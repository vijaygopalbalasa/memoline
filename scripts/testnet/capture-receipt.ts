/**
 * Capture a real Arc Testnet payout transaction as a reconcile test fixture.
 * Read-only: no key, no .env, public RPC only.
 *
 *   pnpm --filter @memoline/scripts exec tsx testnet/capture-receipt.ts <txHash> [fixture-name.json]
 *
 * Each row is rebuilt from the chain alone: the run, row number and reference come from the Memo
 * event's memo bytes (decoded with the ledger's own decoder), and the recipient and amount come from
 * the one token Transfer inside that memo's BeforeMemo…Memo bracket. The script then refuses to write
 * unless the rebuilt rows reproduce every memoId, every callDataHash, the exact memo bytes and the
 * exact transaction input, so the fixture can only ever describe what the transaction really paid.
 */
import { resolve } from 'node:path';
import {
  bracketFor,
  buildChunkCalldata,
  buildTransferCalldata,
  decodeMemoData,
  fromNative18,
  makeClient,
  makePayoutRow,
  type PayoutRow,
  parseReceiptLogs,
  payoutMemoId,
  reconcileReceipt,
  type Token,
} from '@memoline/ledger';
import { getAddress, type Hex, keccak256 } from 'viem';
import { CHAIN_ID, saveJson, T } from './lib.js';

const RPC = 'https://rpc.quicknode.testnet.arc.io';
const UA = 'memoline/0.1';
const FIX = resolve(import.meta.dirname, '../../packages/ledger/test/fixtures');

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function must<V>(value: V | undefined | null | false, message: string): V {
  if (value === undefined || value === null || value === false) throw new Error(message);
  return value;
}

async function main(): Promise<void> {
  const hash = must(
    process.argv[2]?.match(/^0x[0-9a-fA-F]{64}$/)?.[0] as Hex | undefined,
    'usage: capture-receipt.ts <txHash> [fixture-name.json]',
  );
  const client = makeClient({ chainId: CHAIN_ID, primaryUrl: RPC, userAgent: UA });
  const [receipt, tx] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
  ]);
  must(receipt.status === 'success', `transaction ${hash} did not succeed (status ${receipt.status})`);
  must(
    receipt.to !== null && eq(receipt.to, T.multicall3From.address),
    `transaction ${hash} was not sent to Multicall3From`,
  );
  const sender = getAddress(receipt.from);

  // The token is whatever every memo in the transaction targeted.
  const probe = parseReceiptLogs(receipt.logs, {
    systemEmitter: T.systemEmitter.address,
    memo: T.memo.address,
    token: T.eurc.address,
    tokenIsUsdc: false,
    usdc: T.usdc.address,
  });
  must(probe.memos.length > 0, `transaction ${hash} carries no Memo events`);
  const targets = new Set(probe.memos.map((m) => m.target.toLowerCase()));
  must(targets.size === 1, `memos in ${hash} target more than one token`);
  const target = must([...targets][0], 'no memo target');
  const token: Token = eq(target, T.usdc.address)
    ? 'USDC'
    : must(eq(target, T.eurc.address) && 'EURC', `memo target ${target} is neither USDC nor EURC`);
  const tokenAddr = token === 'USDC' ? T.usdc.address : T.eurc.address;

  const { transfers, memos, beforeMemos } = parseReceiptLogs(receipt.logs, {
    systemEmitter: T.systemEmitter.address,
    memo: T.memo.address,
    token: tokenAddr,
    tokenIsUsdc: token === 'USDC',
    usdc: T.usdc.address,
  });

  let runId: string | undefined;
  const rows: PayoutRow[] = [];
  for (const memo of memos) {
    const data = must(decodeMemoData(memo.memo), `memo ${memo.memoId} is not Memoline memo data`);
    must(data.t === 'po', `memo ${memo.memoId} is not a payout memo (t=${data.t})`);
    const run = must(data.run, `memo ${memo.memoId} has no run id`);
    const rowIndex = must(data.row, `memo ${memo.memoId} has no row number`);
    const reference = must(data.ref, `memo ${memo.memoId} has no reference`);
    runId ??= run;
    must(run === runId, `memo ${memo.memoId} belongs to run ${run}, not ${runId}`);
    must(memo.memoId === payoutMemoId(run, rowIndex), `memoId ${memo.memoId} is not po:${run}:${rowIndex}`);
    must(eq(memo.sender, sender), `memo ${memo.memoId} sender ${memo.sender} is not ${sender}`);

    const br = must(bracketFor(memo, beforeMemos), `memo ${memo.memoId} has no BeforeMemo`);
    const inside = transfers.filter((t) => t.logIndex > br.lo && t.logIndex < br.hi && eq(t.from, sender));
    must(inside.length === 1, `memo ${memo.memoId} brackets ${inside.length} transfers, expected 1`);
    const t = must(inside[0], 'transfer vanished');
    let amount6 = t.value;
    if (token === 'USDC') {
      const { amount6: a6, dust } = fromNative18(t.value);
      must(dust === 0n, `USDC transfer at log ${t.logIndex} has sub-cent dust ${dust}`);
      amount6 = a6;
    }
    const recipient = getAddress(t.to);
    must(
      memo.callDataHash === keccak256(buildTransferCalldata(recipient, amount6)),
      `memo ${memo.memoId} callDataHash does not match transfer(${recipient}, ${amount6})`,
    );
    const row = makePayoutRow(run, rowIndex, recipient, amount6, reference);
    must(row.memoData === memo.memo, `memo ${memo.memoId} bytes differ from what Memoline encodes`);
    rows.push(row);
  }
  const run = must(runId, 'no run id');
  rows.sort((a, b) => a.rowIndex - b.rowIndex);
  must(
    rows.every((r, i) => r.rowIndex === i),
    `row numbers are not 0..${rows.length - 1}: ${rows.map((r) => r.rowIndex).join(',')}`,
  );
  must(
    tx.input === buildChunkCalldata(T.memo.address, tokenAddr, { idx: 0, rows }),
    'rebuilt rows do not reproduce the transaction input exactly',
  );
  const check = reconcileReceipt(receipt, {
    chainId: CHAIN_ID,
    sender,
    token,
    chunk: { idx: 0, rows },
    runId: run,
    blockTime: 0,
  });
  must(
    check.rows.every((r) => r.status === 'RECONCILED') && check.checks.unexplainedTransfers === 0,
    `ledger does not reconcile the rebuilt rows: ${JSON.stringify(check.rows)}`,
  );

  const name = process.argv[3] ?? `receipt-${token.toLowerCase()}-${rows.length}rows.json`;
  saveJson(resolve(FIX, name), { rows, receipt, runId: run, sender, chainId: CHAIN_ID });
  console.log(`wrote ${name}: ${rows.length} ${token} rows, run ${run}, block ${receipt.blockNumber}`);
  for (const r of rows) console.log(`  row ${r.rowIndex}: ${r.amount6} to ${r.recipient} ref ${r.reference}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
