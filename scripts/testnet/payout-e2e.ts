/**
 * Testnet acceptance — payout-e2e (Task 17, T1–T10). Proves the `@memoline/ledger` primitives
 * against live Arc Testnet, mirroring the invariants apps/web's run-service tests assert, without
 * touching Next code or a database. Never imports from apps/web.
 *
 * T1  3 rows → one aggregate3 tx → reconcileReceipt gives 3 RECONCILED + 3 entries → runToCsv's
 *     footer total_paid/rows_paid tie out to the on-chain sum.
 * T2  preflightChunk excludes a blocklisted recipient (MemoFailed unwrap → BLOCKLISTED); the ok
 *     rows are sent and reconcile.
 * T3  parseAmount6('0.0000001') throws; a wrong-checksum mixed-case address fails strict
 *     isAddress; the zero address is rejected by mapRevert. Pure, no chain work.
 * T4  duplicate recipient/reference are warnings, not errors — covered by a csv.ts unit test.
 * T5  120 rows → chunkRows → [100, 20]; send chunk 0 only; a Memo-log idempotency query for chunk
 *     0's memoIds finds the tx, the same query for chunk 1's memoIds finds nothing.
 * T6  the T1 receipt holds both emitters' logs (the USDC-contract duplicate trap) and the
 *     reconciler counts the value transfer exactly once per row.
 * T7  classifySender on contract bytecode; checkSender rejects a real contract (Multicall3) and
 *     accepts the signer.
 * T8  EURC 2-row run (skipped if the signer holds no EURC) reconciles from EURC logs with
 *     amountNative18 null; the gas fee is still denominated in native (18dp) USDC.
 * T9  the T1 export's per-row fees sum to gasUsed * effectiveGasPrice.
 * T10 clampMaxFeePerGas never drops below the 20 Gwei floor; an unknown tx hash makes
 *     getTransactionReceipt/getTransaction throw the errors the DROPPED classification relies on.
 */
import { resolve } from 'node:path';
import {
  AmountError,
  buildChunkCalldata,
  type Chunk,
  checkSender,
  chunkRows,
  clampMaxFeePerGas,
  classifySender,
  FEE,
  makePayoutRow,
  mapRevert,
  memoAbi,
  newRunId,
  PARAMS,
  type PayoutRow,
  type PreflightContext,
  parseAmount6,
  preflightChunk,
  type ReceiptReconciliation,
  type RunReport,
  type RunReportRow,
  reconcileReceipt,
  runFooter,
  runToCsv,
  TOPICS,
} from '@memoline/ledger';
import {
  type Address,
  erc20Abi,
  getAbiItem,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  TransactionNotFoundError,
  type TransactionReceipt,
  TransactionReceiptNotFoundError,
} from 'viem';
import {
  CHAIN_ID,
  createHarness,
  explorer,
  saveJson,
  sendAndWait,
  spikeRecipient,
  T,
  testnetClients,
} from './lib.js';

const OUT = resolve(import.meta.dirname, 'out');
const memoEvent = getAbiItem({ abi: memoAbi, name: 'Memo' });

/** Flips the case of the first hex letter in `addr` so the result still looks like an address
 * (mixed case, right length) but fails EIP-55 checksum validation — the "typo would send funds to
 * the wrong place" case `csv.ts` guards against with BAD_CHECKSUM. */
function breakChecksum(addr: Address): Address {
  const body = addr.slice(2);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === undefined || !/[a-fA-F]/.test(c)) continue;
    const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    const candidate = `0x${body.slice(0, i)}${flipped}${body.slice(i + 1)}` as Address;
    if (!isAddress(candidate, { strict: true })) return candidate;
  }
  throw new Error(`could not construct a checksum-breaking variant of ${addr} (no letters found)`);
}

/** Builds one CSV/JSON export row from a reconciled row, following the same "only set what's
 * known" shape apps/web/src/services/runs.ts uses (required exactOptionalPropertyTypes discipline:
 * never assign `undefined` to an optional field). */
function buildReportRow(
  runId: string,
  row: PayoutRow,
  rec: ReceiptReconciliation,
  receipt: TransactionReceipt,
  blockTime: number,
): RunReportRow {
  const entry = rec.entries.find((e) => e.sourceId === `${runId}:${row.rowIndex}`);
  const outcome = rec.rows.find((x) => x.rowIndex === row.rowIndex);
  const out: RunReportRow = {
    rowIndex: row.rowIndex,
    reference: row.reference,
    recipient: row.recipient,
    amount6: row.amount6,
    status: outcome?.status ?? 'EXCEPTION',
    memoId: row.memoId,
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    blockTime,
    feeChunkNative18: rec.chunkFeeNative18,
    explorerUrl: explorer(receipt.transactionHash),
  };
  if (entry) {
    out.logIndex = entry.logIndex;
    out.feeRowNative18 = entry.feeNative18;
    if (entry.memoIndex !== null) out.memoIndex = entry.memoIndex;
  }
  if (outcome?.reason !== undefined) out.exceptionReason = outcome.reason;
  return out;
}

async function main() {
  const { publicClient, walletClient, account } = testnetClients();
  const SENDER = account.address;
  const { run, summarize, results } = createHarness();
  const totalSentByToken: Record<'USDC' | 'EURC', bigint> = { USDC: 0n, EURC: 0n };

  const usdcBal = await publicClient.readContract({
    address: T.usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [SENDER],
  });
  console.log(`sender ${SENDER} USDC(6dp) balance: ${usdcBal}`);
  if (usdcBal < 1_000_000n) {
    throw new Error('Need ≥ 1 USDC on Arc Testnet to run payout-e2e (fund via faucet.circle.com)');
  }

  // ---- T1: 3 rows, one tx, full reconciliation + export footer ----
  type T1Value = { receipt: TransactionReceipt; report: RunReport; rec: ReceiptReconciliation };
  const t1 = await run<T1Value>('T1', async () => {
    const runId = newRunId();
    const rows = [0, 1, 2].map((i) => makePayoutRow(runId, i, spikeRecipient(11000 + i), 1n, `T1-${i}`));
    const chunk: Chunk = { idx: 0, rows };
    const data = buildChunkCalldata(T.memo.address, T.usdc.address, chunk);
    const receipt = await sendAndWait(walletClient, publicClient, { to: T.multicall3From.address, data });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const blockTime = Number(block.timestamp);
    const rec = reconcileReceipt(receipt, {
      chainId: CHAIN_ID,
      sender: SENDER,
      token: 'USDC',
      chunk,
      runId,
      blockTime,
    });
    const report: RunReport = {
      runId,
      chainId: CHAIN_ID,
      sender: SENDER,
      token: 'USDC',
      csvSha256: 'n/a (payout-e2e T1, no CSV file involved)',
      generatedAt: new Date().toISOString(),
      rows: rows.map((r) => buildReportRow(runId, r, rec, receipt, blockTime)),
    };
    const csv = runToCsv(report);
    const footer = runFooter(report);
    const onChainSum6 = rec.entries.reduce((s, e) => s + e.amount6, 0n);
    const pass =
      rec.rows.every((r) => r.status === 'RECONCILED') &&
      rec.entries.length === 3 &&
      rec.checks.sumOk &&
      footer.rows_paid === 3 &&
      footer.total_paid_base6 === onChainSum6 &&
      csv.includes('rows_paid,3');
    if (pass) totalSentByToken.USDC += onChainSum6;
    saveJson(resolve(OUT, 'payout-e2e-t1-receipt.json'), {
      rows,
      receipt,
      runId,
      sender: SENDER,
      chainId: CHAIN_ID,
    });
    saveJson(resolve(OUT, 'payout-e2e-t1.csv.json'), { csv, footer });
    return {
      pass,
      reason: pass
        ? `3 rows RECONCILED, footer total_paid=${footer.total_paid} rows_paid=${footer.rows_paid}, tx ${explorer(receipt.transactionHash)}`
        : `reconciliation/footer mismatch: rows=${JSON.stringify(rec.rows)} footer=${JSON.stringify(footer)}`,
      value: { receipt, report, rec },
    };
  });

  // ---- T2: blocklisted row excluded at pre-flight, ok rows sent and reconciled ----
  await run('T2', async () => {
    const pctx: PreflightContext = {
      sender: SENDER,
      memoAddress: T.memo.address,
      multicall3From: T.multicall3From.address,
      token: T.usdc.address,
      allow7702: false,
    };
    const runId = newRunId();
    const rows = [
      makePayoutRow(runId, 0, spikeRecipient(11100), 1n, 'T2-OK-0'),
      makePayoutRow(runId, 1, T.blocklistedTest.address, 1n, 'T2-BLOCKED'),
      makePayoutRow(runId, 2, spikeRecipient(11102), 1n, 'T2-OK-2'),
    ];
    const chunk: Chunk = { idx: 0, rows };
    const pf = await preflightChunk(publicClient, pctx, chunk);
    const row0 = pf.rows[0];
    const blockedRow = pf.rows[1];
    const row2 = pf.rows[2];
    const isolatedCorrectly =
      pf.ok === false &&
      row0 !== undefined &&
      row0.ok === true &&
      blockedRow !== undefined &&
      blockedRow.ok === false &&
      blockedRow.error?.code === 'BLOCKLISTED' &&
      row2 !== undefined &&
      row2.ok === true;
    if (!isolatedCorrectly) {
      return {
        pass: false,
        reason: `preflightChunk did not isolate the blocklisted row: ${JSON.stringify(pf.rows)}`,
      };
    }
    const okRows = rows.filter((_, i) => pf.rows[i]?.ok === true);
    const sendChunk: Chunk = { idx: 0, rows: okRows };
    const data = buildChunkCalldata(T.memo.address, T.usdc.address, sendChunk);
    const receipt = await sendAndWait(walletClient, publicClient, { to: T.multicall3From.address, data });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const rec = reconcileReceipt(receipt, {
      chainId: CHAIN_ID,
      sender: SENDER,
      token: 'USDC',
      chunk: sendChunk,
      runId,
      blockTime: Number(block.timestamp),
    });
    const pass = rec.rows.every((r) => r.status === 'RECONCILED') && rec.entries.length === okRows.length;
    if (pass) totalSentByToken.USDC += rec.entries.reduce((s, e) => s + e.amount6, 0n);
    return {
      pass,
      reason: pass
        ? `blocklisted row excluded via MemoFailed unwrap (BLOCKLISTED); ${okRows.length} ok rows sent and RECONCILED, tx ${explorer(receipt.transactionHash)}`
        : `send/reconcile of the ok rows failed: ${JSON.stringify(rec.rows)}`,
    };
  });

  // ---- T3: pure input-validation primitives, no chain work ----
  await run('T3', async () => {
    const reasons: string[] = [];

    let amountThrew = false;
    try {
      parseAmount6('0.0000001');
    } catch (e) {
      amountThrew = e instanceof AmountError;
    }
    if (!amountThrew) reasons.push('parseAmount6("0.0000001") did not throw AmountError');

    const checksummed = getAddress(T.memo.address);
    const broken = breakChecksum(checksummed);
    const structurallyValid = isAddress(broken, { strict: false });
    const checksumValid = isAddress(broken, { strict: true });
    if (!structurallyValid || checksumValid) {
      reasons.push(`checksum-break helper produced an unexpected address: ${broken}`);
    }

    const zero = mapRevert(undefined, { recipient: '0x0000000000000000000000000000000000000000' });
    if (zero.code !== 'ZERO_ADDRESS') reasons.push(`mapRevert did not reject the zero address: ${zero.code}`);

    return {
      pass: reasons.length === 0,
      reason:
        reasons.length === 0
          ? 'parseAmount6 rejects 7 decimals; a wrong-checksum mixed-case address fails strict isAddress (but passes loose); mapRevert rejects the zero address'
          : reasons.join('; '),
    };
  });

  // ---- T4: documented, no chain work ----
  await run('T4', async () => ({
    pass: true,
    reason:
      'covered by unit test (apps/web/test/csv.test.ts: "warnings: duplicate recipient, duplicate reference, recipient equals sender") — duplicates are DUPLICATE_RECIPIENT/DUPLICATE_REFERENCE warnings, not errors; no chain work needed here',
  }));

  // ---- T5: 120 rows → chunkRows [100, 20]; send chunk 0; prove idempotency via memo logs ----
  await run('T5', async () => {
    const runId = newRunId();
    const rows = Array.from({ length: 120 }, (_, i) =>
      makePayoutRow(runId, i, spikeRecipient(11200 + i), 1n, `T5-${i}`),
    );
    const chunkList = chunkRows(rows, PARAMS.maxRowsPerTx);
    const chunk0 = chunkList[0];
    const chunk1 = chunkList[1];
    if (
      chunkList.length !== 2 ||
      !chunk0 ||
      !chunk1 ||
      chunk0.rows.length !== 100 ||
      chunk1.rows.length !== 20
    ) {
      return {
        pass: false,
        reason: `chunkRows(120 rows, maxRows=${PARAMS.maxRowsPerTx}) did not produce [100, 20]: got ${JSON.stringify(chunkList.map((c) => c.rows.length))}`,
      };
    }
    const startBlock = await publicClient.getBlockNumber();
    const data = buildChunkCalldata(T.memo.address, T.usdc.address, chunk0);
    const receipt = await sendAndWait(walletClient, publicClient, { to: T.multicall3From.address, data });
    if (receipt.status !== 'success') {
      return {
        pass: false,
        reason: `chunk 0 send reverted on-chain: tx ${explorer(receipt.transactionHash)}`,
      };
    }
    // Chain-verified accounting (same as T1/T2/T8): sum what reconcileReceipt actually matched
    // on-chain, not the chunk's declared amounts, and only when every row reconciled.
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const rec = reconcileReceipt(receipt, {
      chainId: CHAIN_ID,
      sender: SENDER,
      token: 'USDC',
      chunk: chunk0,
      runId,
      blockTime: Number(block.timestamp),
    });
    const reconciled =
      rec.rows.every((r) => r.status === 'RECONCILED') && rec.entries.length === chunk0.rows.length;
    if (reconciled) totalSentByToken.USDC += rec.entries.reduce((s, e) => s + e.amount6, 0n);

    const logsChunk0 = await publicClient.getLogs({
      address: T.memo.address,
      event: memoEvent,
      args: { sender: SENDER, memoId: chunk0.rows.map((r) => r.memoId) },
      fromBlock: startBlock,
      toBlock: 'latest',
    });
    const logsChunk1 = await publicClient.getLogs({
      address: T.memo.address,
      event: memoEvent,
      args: { sender: SENDER, memoId: chunk1.rows.map((r) => r.memoId) },
      fromBlock: startBlock,
      toBlock: 'latest',
    });
    const chunk0Found =
      logsChunk0.length === chunk0.rows.length &&
      logsChunk0.every((l) => l.transactionHash === receipt.transactionHash);
    const chunk1Empty = logsChunk1.length === 0;
    const pass = reconciled && chunk0Found && chunk1Empty;
    return {
      pass,
      reason: pass
        ? `120 rows → chunks [100, 20]; chunk 0 sent (tx ${explorer(receipt.transactionHash)}), all ${rec.entries.length} rows RECONCILED, memo-log query finds all ${logsChunk0.length} chunk-0 memoIds; the same query for chunk 1's memoIds is empty (idempotency proven)`
        : `reconciled=${reconciled} (entries=${rec.entries.length}/${chunk0.rows.length}), chunk0 memo logs=${logsChunk0.length}/${chunk0.rows.length}, chunk1 memo logs=${logsChunk1.length} (expected 0)`,
    };
  });

  // ---- T6: the T1 receipt holds both emitters' logs; reconciler counts each row once ----
  await run('T6', async () => {
    if (!t1) return { pass: false, reason: 'skipped: T1 did not produce a receipt/reconciliation' };
    const { receipt, rec } = t1;
    const sysLogs = receipt.logs.filter(
      (l) =>
        l.address.toLowerCase() === T.systemEmitter.address.toLowerCase() && l.topics[0] === TOPICS.transfer,
    ).length;
    const usdcLogs = receipt.logs.filter(
      (l) => l.address.toLowerCase() === T.usdc.address.toLowerCase() && l.topics[0] === TOPICS.transfer,
    ).length;
    const pass =
      sysLogs === 3 &&
      usdcLogs === 3 &&
      rec.checks.duplicateUsdcContractLogs === 3 &&
      rec.entries.length === 3;
    return {
      pass,
      reason: pass
        ? `T1 receipt holds systemEmitter Transfer logs=${sysLogs} and USDC-contract Transfer logs=${usdcLogs} (the duplicate trap); reconciler counted duplicateUsdcContractLogs=${rec.checks.duplicateUsdcContractLogs} but wrote exactly ${rec.entries.length} entries`
        : `mismatch: sysLogs=${sysLogs} usdcLogs=${usdcLogs} duplicateUsdcContractLogs=${rec.checks.duplicateUsdcContractLogs} entries=${rec.entries.length}`,
    };
  });

  // ---- T7: sender classification and checkSender against a real contract ----
  await run('T7', async () => {
    const codeIsContract = classifySender('0x6080604052');
    if (codeIsContract !== 'contract') {
      return {
        pass: false,
        reason: `classifySender('0x6080604052') = ${codeIsContract}, expected 'contract'`,
      };
    }
    const baseCtx: PreflightContext = {
      sender: SENDER,
      memoAddress: T.memo.address,
      multicall3From: T.multicall3From.address,
      token: T.usdc.address,
      allow7702: false,
    };
    const contractErr = await checkSender(publicClient, { ...baseCtx, sender: T.multicall3.address });
    const selfErr = await checkSender(publicClient, baseCtx);
    const pass = contractErr?.code === 'SENDER_NOT_EOA' && selfErr === null;
    return {
      pass,
      reason: pass
        ? "classifySender('0x6080…')='contract'; checkSender(Multicall3)='SENDER_NOT_EOA'; checkSender(signer)=null"
        : `contractErr=${JSON.stringify(contractErr)} selfErr=${JSON.stringify(selfErr)}`,
    };
  });

  // ---- T8: EURC run, skipped if unfunded ----
  await run('T8', async () => {
    const eurcBal = await publicClient.readContract({
      address: T.eurc.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [SENDER],
    });
    if (eurcBal === 0n) {
      return {
        pass: true,
        skip: true,
        reason: 'signer has 0 EURC balance (fund via faucet.circle.com to exercise this test)',
      };
    }
    const runId = newRunId();
    const rows = [0, 1].map((i) => makePayoutRow(runId, i, spikeRecipient(11400 + i), 1n, `T8-${i}`));
    const chunk: Chunk = { idx: 0, rows };
    const data = buildChunkCalldata(T.memo.address, T.eurc.address, chunk);
    const receipt = await sendAndWait(walletClient, publicClient, { to: T.multicall3From.address, data });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const rec = reconcileReceipt(receipt, {
      chainId: CHAIN_ID,
      sender: SENDER,
      token: 'EURC',
      chunk,
      runId,
      blockTime: Number(block.timestamp),
    });
    const feeIsNativeUsdc =
      rec.chunkFeeNative18 === receipt.gasUsed * receipt.effectiveGasPrice && rec.chunkFeeNative18 > 0n;
    const pass =
      rec.entries.length === 2 &&
      rec.entries.every((e) => e.amountNative18 === null) &&
      rec.rows.every((r) => r.status === 'RECONCILED') &&
      feeIsNativeUsdc;
    if (pass) totalSentByToken.EURC += rec.entries.reduce((s, e) => s + e.amount6, 0n);
    return {
      pass,
      reason: pass
        ? `EURC 2-row run reconciled from EURC logs (amountNative18=null); fee ${rec.chunkFeeNative18} paid in native (18dp) USDC gas, tx ${explorer(receipt.transactionHash)}`
        : `EURC reconciliation mismatch: ${JSON.stringify(rec.rows)}`,
    };
  });

  // ---- T9: the T1 export's per-row fees sum to gasUsed * effectiveGasPrice ----
  await run('T9', async () => {
    if (!t1) return { pass: false, reason: 'skipped: T1 did not produce an export' };
    const { report, receipt } = t1;
    const feeSum = report.rows.reduce((s, r) => s + (r.feeRowNative18 ?? 0n), 0n);
    const expected = receipt.gasUsed * receipt.effectiveGasPrice;
    const pass = feeSum === expected;
    return {
      pass,
      reason: pass
        ? `T1 export's per-row fees sum to ${feeSum} = gasUsed(${receipt.gasUsed}) * effectiveGasPrice(${receipt.effectiveGasPrice})`
        : `fee sum ${feeSum} != expected ${expected}`,
    };
  });

  // ---- T10: fee floor and DROPPED-classification inputs ----
  await run('T10', async () => {
    const clamped = clampMaxFeePerGas(1n);
    if (clamped !== FEE.minMaxFeePerGasWei) {
      return {
        pass: false,
        reason: `clampMaxFeePerGas(1n) = ${clamped}, expected the 20 Gwei floor ${FEE.minMaxFeePerGasWei}`,
      };
    }
    const randomHash = keccak256(stringToHex(`memoline-t10-${Date.now()}-${Math.random()}`));
    let receiptThrew = false;
    let receiptErrType = '';
    try {
      await publicClient.getTransactionReceipt({ hash: randomHash });
    } catch (e) {
      receiptThrew = e instanceof TransactionReceiptNotFoundError;
      receiptErrType = e instanceof Error ? e.constructor.name : String(e);
    }
    let txThrew = false;
    let txErrType = '';
    try {
      await publicClient.getTransaction({ hash: randomHash });
    } catch (e) {
      txThrew = e instanceof TransactionNotFoundError;
      txErrType = e instanceof Error ? e.constructor.name : String(e);
    }
    const pass = receiptThrew && txThrew;
    return {
      pass,
      reason: pass
        ? `clampMaxFeePerGas(1n) floors to 20 Gwei; unknown hash ${randomHash} makes getTransactionReceipt throw TransactionReceiptNotFoundError and getTransaction throw TransactionNotFoundError (the DROPPED classification inputs)`
        : `got receiptErr=${receiptErrType} txErr=${txErrType} for hash ${randomHash}`,
    };
  });

  saveJson(resolve(OUT, 'payout-e2e-results.json'), {
    chainId: CHAIN_ID,
    sender: SENDER,
    finishedAt: new Date().toISOString(),
    results,
    totalSentByToken,
  });
  console.log(`\nwrote ${resolve(OUT, 'payout-e2e-results.json')}`);

  if (!summarize()) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
