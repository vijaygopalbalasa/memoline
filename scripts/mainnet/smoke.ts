/**
 * Mainnet smoke test (Task 18) — the mainnet equivalent of `scripts/testnet/payout-e2e.ts`'s T1, at
 * mainnet scale and stakes. Sends 3 rows totalling exactly 5.00 USDC (1.00 / 2.00 / 2.00) to three
 * recipients on Arc mainnet (chain 5042), pre-flights first, sends one `aggregate3` transaction,
 * reconciles the receipt, and asserts all 3 rows RECONCILED with fees tying out.
 *
 * DANGER — this signs and broadcasts a real mainnet transaction that moves real USDC. It is never run
 * by CI, by an agent, or as part of any automated pipeline. A human runs it by hand, deliberately, with
 * a wallet set aside for exactly this purpose (never the wallet that holds the testnet signer key).
 *
 * Reads `scripts/mainnet/.env` (git-ignored, never committed):
 *   PRIVATE_KEY       - the smoke-test signer's key. Must be a wallet set aside for this alone.
 *   ADDRESS           - that key's address, as a cross-check (see refuseToRun below).
 *   ARC_RPC           - a mainnet Arc RPC endpoint. No default: the operator must choose one deliberately.
 * Reads from the process environment (not the .env file, so it's easy to pass per-invocation):
 *   SMOKE_RECIPIENTS  - exactly 3 comma-separated, EIP-55 checksummed addresses. Required, no default —
 *                       this script never invents a recipient for a real mainnet send.
 *
 * Refuses to run (before touching the network, or before sending, depending on the check) if:
 *   - the derived signer address equals the testnet signer 0x427C62eDCae20DDc8c5e875De39D4E4845491458
 *   - ADDRESS does not match the address PRIVATE_KEY derives
 *   - SMOKE_RECIPIENTS is missing, not exactly 3 entries, or any entry fails strict EIP-55 checksum
 *   - the RPC's chain ID is not 5042 (Arc mainnet)
 *   - the signer's USDC balance is below 6 USDC (5 to send + headroom for gas, which Arc also charges
 *     in USDC — its native currency is USDC at 18 decimals)
 *   - the signer is not a plain EOA (Memo/Multicall3From require tx.origin == sender)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ADDRESSES,
  arcMainnet,
  buildChunkCalldata,
  type Chunk,
  checkSender,
  clampMaxFeePerGas,
  explorerTxUrl,
  FEE,
  makeClient,
  makePayoutRow,
  newRunId,
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
} from '@memoline/ledger';
import { config } from 'dotenv';
import {
  type Address,
  createWalletClient,
  erc20Abi,
  type Hex,
  http,
  isAddress,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const UA = 'memoline-scripts/0.1 (+https://memoline.io)';
const CHAIN_ID = 5042 as const;
const TESTNET_SIGNER = '0x427C62eDCae20DDc8c5e875De39D4E4845491458';
// dRPC's free tier is unsuitable for anything beyond a single eth_call/eth_sendRawTransaction (see
// packages/ledger/src/chain/client.ts); QuickNode's public mainnet mirror is used only as a fallback
// transport for the pre-flight eth_call, never as the primary — the operator's ARC_RPC always is.
const FALLBACK_RPC = 'https://rpc.quicknode.mainnet.arc.io';
const OUT = resolve(import.meta.dirname, 'out');

/** Thrown by every refuseToRun check below — distinct from a plain runtime error so `main`'s catch can
 * report it as a deliberate refusal, not a bug. */
class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusalError';
  }
}
function refuse(message: string): never {
  throw new RefusalError(message);
}

type MainnetEnv = { privateKey: Hex; address: Address; rpc: string; recipients: [Address, Address, Address] };

/** Loads and validates every input needed to run, refusing before any network call if anything is
 * missing, malformed, or points at the wrong wallet. */
function loadAndValidateEnv(): MainnetEnv {
  config({ path: resolve(import.meta.dirname, '.env'), quiet: true });

  const pk = process.env.PRIVATE_KEY as Hex | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    refuse('scripts/mainnet/.env: PRIVATE_KEY missing or malformed (expected 0x + 64 hex chars)');
  }
  const account = privateKeyToAccount(pk);

  if (account.address.toLowerCase() === TESTNET_SIGNER.toLowerCase()) {
    refuse(
      `PRIVATE_KEY derives ${account.address}, which is the testnet signer (${TESTNET_SIGNER}). ` +
        'Refusing to run a mainnet send from the testnet key — use a separate, human-controlled wallet.',
    );
  }

  const expected = process.env.ADDRESS;
  if (!expected) refuse('scripts/mainnet/.env: ADDRESS is required (cross-check against PRIVATE_KEY)');
  if (expected.toLowerCase() !== account.address.toLowerCase()) {
    refuse(`PRIVATE_KEY derives ${account.address} but ADDRESS says ${expected} — refusing to run`);
  }

  const rpc = process.env.ARC_RPC;
  if (!rpc) refuse('scripts/mainnet/.env: ARC_RPC is required — no default for a real mainnet send');

  const raw = process.env.SMOKE_RECIPIENTS;
  if (!raw || raw.trim() === '') {
    refuse('SMOKE_RECIPIENTS is required: 3 comma-separated, EIP-55 checksummed addresses');
  }
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 3) {
    refuse(`SMOKE_RECIPIENTS must have exactly 3 addresses, got ${parts.length}: ${raw}`);
  }
  for (const p of parts) {
    if (!isAddress(p, { strict: true })) {
      refuse(`SMOKE_RECIPIENTS entry "${p}" is not a strictly EIP-55 checksummed address`);
    }
  }
  const [r0, r1, r2] = parts as [string, string, string];
  const recipients: [Address, Address, Address] = [r0 as Address, r1 as Address, r2 as Address];

  return { privateKey: pk, address: account.address, rpc, recipients };
}

function saveJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v), 2),
  );
}

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
    explorerUrl: explorerTxUrl(CHAIN_ID, receipt.transactionHash),
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
  const env = loadAndValidateEnv();
  const SENDER = env.address;
  const T = ADDRESSES[CHAIN_ID];

  const publicClient = makeClient({
    chainId: CHAIN_ID,
    primaryUrl: env.rpc,
    fallbackUrl: FALLBACK_RPC,
    userAgent: UA,
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    refuse(`ARC_RPC reports chain ID ${chainId}, expected Arc mainnet (${CHAIN_ID}) — refusing to run`);
  }

  const usdcBal = await publicClient.readContract({
    address: T.usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [SENDER],
  });
  console.log(`sender ${SENDER} USDC(6dp) balance: ${usdcBal}`);
  const MIN_BALANCE = 6_000_000n; // 5.00 to send + headroom for gas (Arc's native currency is USDC)
  if (usdcBal < MIN_BALANCE) {
    refuse(`sender USDC balance ${usdcBal} is below the 6 USDC minimum required to run this smoke test`);
  }

  const account = privateKeyToAccount(env.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: arcMainnet,
    transport: http(env.rpc, { fetchOptions: { headers: { 'User-Agent': UA } } }),
  });

  const pctx: PreflightContext = {
    sender: SENDER,
    memoAddress: T.memo.address,
    multicall3From: T.multicall3From.address,
    token: T.usdc.address,
    allow7702: false,
  };
  const senderErr = await checkSender(publicClient, pctx);
  if (senderErr) {
    refuse(`sender ${SENDER} failed the EOA check: ${senderErr.code} — ${senderErr.message}`);
  }

  const runId = newRunId();
  const amounts = [parseAmount6('1.00'), parseAmount6('2.00'), parseAmount6('2.00')];
  const rows: PayoutRow[] = env.recipients.map((recipient, i) => {
    const amount = amounts[i];
    if (amount === undefined) throw new Error('internal: amounts/recipients length mismatch');
    return makePayoutRow(runId, i, recipient, amount, `mainnet-smoke-${runId}-${i}`);
  });
  const total = amounts.reduce((s, a) => s + a, 0n);
  if (total !== 5_000_000n) throw new Error(`internal: expected exactly 5.00 USDC total, got ${total}`);
  const chunk: Chunk = { idx: 0, rows };

  console.log(`pre-flighting 1 chunk of ${rows.length} rows (${runId})…`);
  const pf = await preflightChunk(publicClient, pctx, chunk);
  if (!pf.ok) {
    console.error('pre-flight failed:', JSON.stringify(pf.rows, null, 2));
    throw new Error('pre-flight rejected this chunk — refusing to send. See row errors above.');
  }
  console.log(`pre-flight OK, estimated gas: ${pf.gasEstimate}`);

  const data = buildChunkCalldata(T.memo.address, T.usdc.address, chunk);
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = clampMaxFeePerGas(fees.maxFeePerGas ?? 0n);
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? FEE.defaultPriorityFeeWei;

  console.log(`sending aggregate3 to ${T.multicall3From.address}…`);
  const hash = await walletClient.sendTransaction({
    account,
    chain: arcMainnet,
    to: T.multicall3From.address,
    data,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  console.log(`sent ${hash}, waiting for receipt…`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
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
    csvSha256: 'n/a (mainnet smoke test, no CSV file involved)',
    generatedAt: new Date().toISOString(),
    rows: rows.map((r) => buildReportRow(runId, r, rec, receipt, blockTime)),
  };
  const csv = runToCsv(report);
  const footer = runFooter(report);
  const feeSum = report.rows.reduce((s, r) => s + (r.feeRowNative18 ?? 0n), 0n);
  const expectedFee = receipt.gasUsed * receipt.effectiveGasPrice;

  const explorerUrl = explorerTxUrl(CHAIN_ID, receipt.transactionHash);
  const csvPath = resolve(OUT, `mainnet-smoke-${runId}.csv`);
  writeFileSyncCsv(csvPath, csv);
  saveJson(resolve(OUT, `mainnet-smoke-${runId}-receipt.json`), { rows, receipt, runId, sender: SENDER });

  const allReconciled = rec.rows.every((r) => r.status === 'RECONCILED');
  const feesTieOut = feeSum === expectedFee && rec.chunkFeeNative18 === expectedFee;
  const pass =
    allReconciled &&
    rec.entries.length === 3 &&
    rec.checks.sumOk &&
    footer.total_paid_base6 === 5_000_000n &&
    feesTieOut;

  console.log(`\nexplorer: ${explorerUrl}`);
  console.log(`csv export: ${csvPath}`);
  console.log(`footer: ${JSON.stringify(footer, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);

  if (!pass) {
    console.error(
      `\nRECONCILIATION FAILED after a real send — inspect the transaction above by hand.\n` +
        `rows=${JSON.stringify(rec.rows)}\nchecks=${JSON.stringify(rec.checks)}\n` +
        `feeSum=${feeSum} expectedFee=${expectedFee}`,
    );
    process.exit(1);
  }
  console.log(
    `\nPASS — 3/3 rows RECONCILED, total paid ${footer.total_paid} USDC, fees tie out (${feeSum} = gasUsed(${receipt.gasUsed}) * effectiveGasPrice(${receipt.effectiveGasPrice})).`,
  );
}

function writeFileSyncCsv(path: string, csv: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, csv);
}

main().catch((e) => {
  if (e instanceof RefusalError) {
    console.error(`REFUSED: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
