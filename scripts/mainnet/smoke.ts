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
 *   ADDRESS           - that key's address, as a cross-check (see loadAndValidateEnv below).
 *   ARC_RPC           - a mainnet Arc RPC endpoint. No default: the operator must choose one deliberately.
 * Reads from the process environment (not the .env file, so it's easy to pass per-invocation):
 *   SMOKE_RECIPIENTS  - exactly 3 comma-separated, EIP-55 checksummed addresses. Required, no default —
 *                       this script never invents a recipient for a real mainnet send.
 * NOTE: `dotenv` never overrides a variable already present in the environment — run this in a clean
 * shell (no stale exported PRIVATE_KEY/ADDRESS/ARC_RPC from an earlier session) or you may silently
 * reuse the wrong wallet or endpoint.
 *
 * Refuses to send (before touching the network, or before broadcasting, depending on the check) if:
 *   - the derived signer address equals the testnet signer 0x427C62eDCae20DDc8c5e875De39D4E4845491458
 *   - ADDRESS does not match the address PRIVATE_KEY derives
 *   - SMOKE_RECIPIENTS is missing, not exactly 3 entries, or any entry fails strict EIP-55 checksum
 *   - the RPC's chain ID is not 5042 (Arc mainnet)
 *   - the signer's USDC balance is below 6 USDC (5 to send + headroom for gas, which Arc also charges
 *     in USDC — its native currency is USDC at 18 decimals)
 *   - the signer is not a plain EOA (Memo/Multicall3From require tx.origin == sender)
 *
 * DOUBLE-SEND GUARD (`scripts/mainnet/out/pending.json`): a fresh run's intent (recipients, amounts,
 * the block height just before sending) is written to this file *before* `sendTransaction` is called,
 * and rewritten with the transaction hash the moment `sendTransaction` returns one. If the script is
 * re-invoked while this file exists, it never sends a new transaction — it resumes: it looks up the
 * pending run's fate (by hash if one was recorded, otherwise by querying Memo logs for the pending
 * run's exact memoIds) and reconciles whatever it finds instead. The file is only deleted once a
 * receipt has actually been fetched and reconciled — i.e. once the on-chain outcome is known for
 * certain. See DEPLOY.md §6 ("Resuming an interrupted smoke run") for the operator-facing version of
 * this. This is intentionally simpler than the web app's DB-backed chunk leases (`services/runs.ts`):
 * a single human running one transaction by hand needs a crash-safe file, not a lease server.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  memoAbi,
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
  getAbiItem,
  type Hex,
  http,
  isAddress,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const UA = 'memoline-scripts/0.1 (+https://github.com/vijaygopalbalasa/memoline)';
const CHAIN_ID = 5042 as const;
const TESTNET_SIGNER = '0x427C62eDCae20DDc8c5e875De39D4E4845491458';
// dRPC's free tier is unsuitable for anything beyond a single eth_call/eth_sendRawTransaction (see
// packages/ledger/src/chain/client.ts); QuickNode's public mainnet mirror is used only as a fallback
// transport for the pre-flight eth_call, never as the primary — the operator's ARC_RPC always is.
const FALLBACK_RPC = 'https://rpc.quicknode.mainnet.arc.io';
const OUT = resolve(import.meta.dirname, 'out');
const PENDING_PATH = resolve(OUT, 'pending.json');
const memoEvent = getAbiItem({ abi: memoAbi, name: 'Memo' });

/** Thrown by every refuse() below — distinct from a plain runtime error so `main`'s catch can report
 * it as a deliberate refusal, not a bug. */
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

// ---- pending.json: the double-send guard ----

type PendingRow = { rowIndex: number; recipient: Address; amount6: string; reference: string };
type PendingRun = {
  runId: string;
  sender: Address;
  token: 'USDC';
  chainId: typeof CHAIN_ID;
  startBlock: string;
  createdAt: string;
  rows: PendingRow[];
  txHash?: Hex;
};

function isPendingRow(x: unknown): x is PendingRow {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.rowIndex === 'number' &&
    typeof r.recipient === 'string' &&
    typeof r.amount6 === 'string' &&
    typeof r.reference === 'string'
  );
}

/** Structural validation only (this file guards real money — never guess a repair, refuse instead). */
function validatePending(x: unknown): PendingRun {
  if (typeof x !== 'object' || x === null) refuse(`${PENDING_PATH} does not contain a JSON object`);
  const p = x as Record<string, unknown>;
  if (typeof p.runId !== 'string' || typeof p.sender !== 'string' || p.token !== 'USDC') {
    refuse(`${PENDING_PATH} is missing runId/sender/token — inspect it by hand, do not delete blindly`);
  }
  if (p.chainId !== CHAIN_ID)
    refuse(`${PENDING_PATH} has chainId ${String(p.chainId)}, expected ${CHAIN_ID}`);
  if (typeof p.startBlock !== 'string' || typeof p.createdAt !== 'string') {
    refuse(`${PENDING_PATH} is missing startBlock/createdAt`);
  }
  if (!Array.isArray(p.rows) || p.rows.length !== 3 || !p.rows.every(isPendingRow)) {
    refuse(`${PENDING_PATH} does not have exactly 3 well-formed rows`);
  }
  if (p.txHash !== undefined && (typeof p.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(p.txHash))) {
    refuse(`${PENDING_PATH} has a malformed txHash`);
  }
  return {
    runId: p.runId,
    sender: p.sender as Address,
    token: 'USDC',
    chainId: CHAIN_ID,
    startBlock: p.startBlock,
    createdAt: p.createdAt,
    rows: p.rows as PendingRow[],
    ...(p.txHash !== undefined ? { txHash: p.txHash as Hex } : {}),
  };
}

function loadPending(): PendingRun | null {
  if (!existsSync(PENDING_PATH)) return null;
  const raw = readFileSync(PENDING_PATH, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    refuse(
      `${PENDING_PATH} exists but is not valid JSON (${(e as Error).message}) — a previous run may have ` +
        'been interrupted mid-write. Inspect it by hand before deciding whether it is safe to delete; ' +
        'refusing to guess.',
    );
  }
  return validatePending(parsed);
}

/** Write-then-rename so a crash mid-write never leaves a half-written (corrupt) pending.json — the file
 * that stands between a re-invocation and a duplicate real payment must never be ambiguous. */
function savePending(p: PendingRun): void {
  mkdirSync(dirname(PENDING_PATH), { recursive: true });
  const tmp = `${PENDING_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, PENDING_PATH);
}

function deletePending(): void {
  rmSync(PENDING_PATH, { force: true });
}

function pendingToRows(p: PendingRun): PayoutRow[] {
  return p.rows
    .slice()
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .map((r) => makePayoutRow(p.runId, r.rowIndex, r.recipient, BigInt(r.amount6), r.reference));
}

// ---- shared helpers ----

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

/**
 * Reconciles a receipt against a (fresh or resumed) pending run, exports the CSV/JSON, prints the
 * result, and reports whether every row RECONCILED with fees tying out. Shared by the fresh-send path
 * and both resume paths so all three assert exactly the same thing the same way.
 */
async function finalize(
  publicClient: PublicClient,
  pending: PendingRun,
  receipt: TransactionReceipt,
): Promise<boolean> {
  const rows = pendingToRows(pending);
  const chunk: Chunk = { idx: 0, rows };
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const blockTime = Number(block.timestamp);

  const rec = reconcileReceipt(receipt, {
    chainId: CHAIN_ID,
    sender: pending.sender,
    token: 'USDC',
    chunk,
    runId: pending.runId,
    blockTime,
  });
  const report: RunReport = {
    runId: pending.runId,
    chainId: CHAIN_ID,
    sender: pending.sender,
    token: 'USDC',
    csvSha256: 'n/a (mainnet smoke test, no CSV file involved)',
    generatedAt: new Date().toISOString(),
    rows: rows.map((r) => buildReportRow(pending.runId, r, rec, receipt, blockTime)),
  };
  const csv = runToCsv(report);
  const footer = runFooter(report);
  const feeSum = report.rows.reduce((s, r) => s + (r.feeRowNative18 ?? 0n), 0n);
  const expectedFee = receipt.gasUsed * receipt.effectiveGasPrice;

  const explorerUrl = explorerTxUrl(CHAIN_ID, receipt.transactionHash);
  const csvPath = resolve(OUT, `mainnet-smoke-${pending.runId}.csv`);
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, csv);
  saveJson(resolve(OUT, `mainnet-smoke-${pending.runId}-receipt.json`), {
    rows,
    receipt,
    runId: pending.runId,
    sender: pending.sender,
  });

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
      `\nRECONCILIATION FAILED — inspect the transaction above by hand.\n` +
        `rows=${JSON.stringify(rec.rows)}\nchecks=${JSON.stringify(rec.checks)}\n` +
        `feeSum=${feeSum} expectedFee=${expectedFee}`,
    );
  } else {
    console.log(
      `\nPASS — 3/3 rows RECONCILED, total paid ${footer.total_paid} USDC, fees tie out ` +
        `(${feeSum} = gasUsed(${receipt.gasUsed}) * effectiveGasPrice(${receipt.effectiveGasPrice})).`,
    );
  }
  return pass;
}

/**
 * `pending.json` exists: a previous invocation started (or fully sent) a run and never confirmed it
 * cleanly. Never sends a new transaction here — only looks up what actually happened and reconciles
 * it. `pending.json` is deleted once a receipt is found and processed (the on-chain outcome is then
 * certain, whether or not reconciliation itself passed) — never before that.
 */
async function resumePending(publicClient: PublicClient, pending: PendingRun): Promise<never> {
  console.log(
    `found ${PENDING_PATH} from ${pending.createdAt} (run ${pending.runId}) — resuming instead of ` +
      'sending a new transaction.',
  );

  if (pending.txHash) {
    console.log(`pending run already has txHash ${pending.txHash} — looking up its receipt…`);
    let receipt: TransactionReceipt;
    try {
      receipt = await publicClient.getTransactionReceipt({ hash: pending.txHash });
    } catch {
      console.error(
        `\nno receipt found yet for ${pending.txHash}.\n` +
          `Check ${explorerTxUrl(CHAIN_ID, pending.txHash)} by hand — it may still be pending, or it may ` +
          'have been dropped. Re-run this script later to check again. Do NOT delete pending.json and do ' +
          'NOT re-run with a fresh send until you know which.',
      );
      process.exit(1);
    }
    const pass = await finalize(publicClient, pending, receipt);
    deletePending();
    process.exit(pass ? 0 : 1);
  }

  console.log('pending run has no txHash — the previous attempt may have died before broadcasting.');
  console.log("checking Memo logs for this run's exact memoIds…");
  const rows = pendingToRows(pending);
  const logs = await publicClient.getLogs({
    address: ADDRESSES[CHAIN_ID].memo.address,
    event: memoEvent,
    args: { sender: pending.sender, memoId: rows.map((r) => r.memoId) },
    fromBlock: BigInt(pending.startBlock),
    toBlock: 'latest',
  });
  const adoptedHash = logs[0]?.transactionHash;
  if (!adoptedHash) {
    console.error(
      '\nno Memo logs found for this pending run — the previous attempt did not land on-chain.\n' +
        `If you are confident it never will, delete ${PENDING_PATH} by hand to retry with a fresh send. ` +
        'Refusing to delete it automatically.',
    );
    process.exit(1);
  }
  console.log(`found ${logs.length} matching Memo log(s) — adopting tx ${adoptedHash}`);
  const receipt = await publicClient.getTransactionReceipt({ hash: adoptedHash });
  const pass = await finalize(publicClient, pending, receipt);
  deletePending();
  process.exit(pass ? 0 : 1);
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

  const pending = loadPending();
  if (pending) {
    await resumePending(publicClient, pending);
    return; // unreachable: resumePending always exits the process
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

  const startBlock = await publicClient.getBlockNumber();
  const pending2: PendingRun = {
    runId,
    sender: SENDER,
    token: 'USDC',
    chainId: CHAIN_ID,
    startBlock: startBlock.toString(),
    createdAt: new Date().toISOString(),
    rows: rows.map((r) => ({
      rowIndex: r.rowIndex,
      recipient: r.recipient,
      amount6: r.amount6.toString(),
      reference: r.reference,
    })),
  };
  savePending(pending2);
  console.log(`wrote ${PENDING_PATH} — this run will not send a second time even if this process dies now.`);

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
  pending2.txHash = hash;
  savePending(pending2);
  console.log(
    `sent ${hash} — if this run does not complete, DO NOT re-run; re-invoke this script to resume from ${PENDING_PATH}`,
  );

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  const pass = await finalize(publicClient, pending2, receipt);
  deletePending();
  if (!pass) process.exit(1);
}

main().catch((e) => {
  if (e instanceof RefusalError) {
    console.error(`REFUSED: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
