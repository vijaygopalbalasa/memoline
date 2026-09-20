/**
 * Testnet acceptance — import-e2e (Task 17). Proves the import side of `@memoline/ledger` against
 * live Arc Testnet: `fetchAddressLogs` → enrich (receipts + block times, bounded concurrency) →
 * `reconcileAddress`, then checks the invariants apps/web's import-service tests assert. Never
 * imports from apps/web.
 *
 * Assertions:
 *  - every entry's (txHash, logIndex) is unique (reconcileAddress dedupes correctly on live data);
 *  - every outgoing entry has memoId !== null (all our sends in this session were memo'd, and
 *    fetching receipts lets reconcileAddress read the BeforeMemo/Memo bracket off the receipt);
 *  - the sum of outgoing amounts (per token) is at least what this session's payout-e2e sent,
 *    read from out/payout-e2e-results.json when present (a bare run of import-e2e alone still
 *    passes trivially, since the floor is then zero).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchAddressLogs, PARAMS, reconcileAddress } from '@memoline/ledger';
import type { Hex, Log, TransactionReceipt } from 'viem';
import { CHAIN_ID, createHarness, mapLimit, saveJson, testnetClients } from './lib.js';

const OUT = resolve(import.meta.dirname, 'out');
const CONCURRENCY = 8;

type PayoutResults = { totalSentByToken?: { USDC?: string; EURC?: string } };

function loadSessionFloor(): { USDC: bigint; EURC: bigint } {
  const path = resolve(OUT, 'payout-e2e-results.json');
  if (!existsSync(path)) return { USDC: 0n, EURC: 0n };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PayoutResults;
  const usdc = parsed.totalSentByToken?.USDC;
  const eurc = parsed.totalSentByToken?.EURC;
  return {
    USDC: usdc === undefined ? 0n : BigInt(usdc),
    EURC: eurc === undefined ? 0n : BigInt(eurc),
  };
}

async function main() {
  const { publicClient, account } = testnetClients();
  const SENDER = account.address;
  const { record, run, summarize, results } = createHarness();

  const head = await publicClient.getBlockNumber();
  const span = BigInt(PARAMS.logPageBlocks.start); // "the last 200,000 blocks"
  const fromBlock = head > span ? head - span : 0n;

  const logs = await run<Log[]>('fetch', async () => {
    const collected = await fetchAddressLogs(publicClient, {
      chainId: CHAIN_ID,
      address: SENDER,
      fromBlock,
      toBlock: head,
      onPage: (p) =>
        console.log(`  fetched blocks ${p.from}..${p.to} (page size ${p.to - p.from + 1n}, ${p.logs} logs)`),
    });
    return {
      pass: collected.complete,
      reason: collected.complete
        ? `fetched ${collected.logs.length} logs for ${SENDER} over blocks ${fromBlock}..${head}`
        : `fetch stopped early at block ${collected.scannedToBlock} (wanted ${head}) — ${collected.logs.length} logs collected so far`,
      value: collected.logs,
    };
  });
  if (!logs) {
    saveJson(resolve(OUT, 'import-e2e-results.json'), {
      chainId: CHAIN_ID,
      sender: SENDER,
      results,
      finishedAt: new Date().toISOString(),
    });
    if (!summarize()) process.exit(1);
    return;
  }

  const txs = [...new Set(logs.map((l) => l.transactionHash).filter((h): h is Hex => h !== null))];
  const receiptsArr = await mapLimit(txs, CONCURRENCY, (h) =>
    publicClient.getTransactionReceipt({ hash: h }),
  );
  const receiptsByTx = new Map<Hex, TransactionReceipt>(
    txs.map((h, i): [Hex, TransactionReceipt] => {
      const r = receiptsArr[i];
      if (!r) throw new Error(`missing receipt for tx ${h}`);
      return [h, r];
    }),
  );

  const blocks = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null))];
  const blocksArr = await mapLimit(blocks, CONCURRENCY, (b) => publicClient.getBlock({ blockNumber: b }));
  const blockTimes = new Map<bigint, number>(
    blocks.map((b, i): [bigint, number] => {
      const blk = blocksArr[i];
      if (!blk) throw new Error(`missing block ${b}`);
      return [b, Number(blk.timestamp)];
    }),
  );

  record(
    'enrich',
    true,
    `fetched ${receiptsByTx.size} receipts and ${blockTimes.size} block timestamps (concurrency ${CONCURRENCY})`,
  );

  const entries = reconcileAddress({
    chainId: CHAIN_ID,
    address: SENDER,
    logs,
    receiptsByTx,
    blockTimes,
    importId: 'import-e2e',
  });

  await run('unique-keys', async () => {
    const seen = new Set<string>();
    let dupes = 0;
    for (const e of entries) {
      const key = `${e.txHash}:${e.logIndex}`;
      if (seen.has(key)) dupes++;
      seen.add(key);
    }
    const pass = dupes === 0;
    return {
      pass,
      reason: pass
        ? `all ${entries.length} entries have a unique (txHash, logIndex)`
        : `${dupes} of ${entries.length} entries share a (txHash, logIndex) with another entry`,
    };
  });

  const outgoing = entries.filter((e) => e.direction === 'out');
  await run('outgoing-memoized', async () => {
    const missing = outgoing.filter((e) => e.memoId === null).length;
    const pass = outgoing.length > 0 && missing === 0;
    return {
      pass,
      reason: pass
        ? `all ${outgoing.length} outgoing entries carry a memoId (every payout-e2e send is memo'd)`
        : outgoing.length === 0
          ? 'no outgoing entries found in the lookback window — run payout-e2e first'
          : `${missing} of ${outgoing.length} outgoing entries have memoId === null`,
    };
  });

  await run('sum-at-least-session', async () => {
    const floor = loadSessionFloor();
    const sumByToken = { USDC: 0n, EURC: 0n };
    for (const e of outgoing) sumByToken[e.token] += e.amount6;
    const pass = sumByToken.USDC >= floor.USDC && sumByToken.EURC >= floor.EURC;
    return {
      pass,
      reason: pass
        ? `outgoing sums USDC=${sumByToken.USDC} EURC=${sumByToken.EURC} >= this session's payout-e2e sends USDC=${floor.USDC} EURC=${floor.EURC}`
        : `outgoing sums USDC=${sumByToken.USDC} EURC=${sumByToken.EURC} fall short of payout-e2e's USDC=${floor.USDC} EURC=${floor.EURC}`,
    };
  });

  saveJson(resolve(OUT, 'import-e2e-results.json'), {
    chainId: CHAIN_ID,
    sender: SENDER,
    fromBlock,
    toBlock: head,
    entryCount: entries.length,
    results,
    finishedAt: new Date().toISOString(),
  });
  console.log(`\nwrote ${resolve(OUT, 'import-e2e-results.json')}`);

  if (!summarize()) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
