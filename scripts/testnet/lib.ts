import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  ADDRESSES,
  arcTestnetChain,
  clampMaxFeePerGas,
  explorerTxUrl,
  FEE,
  makeClient,
} from '@memoline/ledger';
import { config } from 'dotenv';
import {
  type Address,
  createWalletClient,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  stringToHex,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const UA = 'memoline-scripts/0.1 (+https://github.com/vijaygopalbalasa/memoline)';
export const CHAIN_ID = 5042002 as const;
export const T = ADDRESSES[CHAIN_ID];

export function loadTestnetEnv(): { privateKey: Hex; address: Address; rpc: string } {
  config({ path: resolve(import.meta.dirname, '.env'), quiet: true });
  const pk = process.env.PRIVATE_KEY as Hex | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk))
    throw new Error('scripts/testnet/.env: PRIVATE_KEY missing or malformed');
  const account = privateKeyToAccount(pk);
  const expected = process.env.ADDRESS;
  if (expected && expected.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `PRIVATE_KEY derives ${account.address} but ADDRESS says ${expected} — refusing to run with a mismatched key`,
    );
  }
  return {
    privateKey: pk,
    address: account.address,
    rpc: process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io',
  };
}

export function testnetClients() {
  const env = loadTestnetEnv();
  const account = privateKeyToAccount(env.privateKey);
  const publicClient = makeClient({
    chainId: CHAIN_ID,
    primaryUrl: env.rpc,
    // dRPC's free tier is unsuitable for history: it advertises a 10,000-block eth_getLogs cap but
    // was observed failing at 500 blocks (100 blocks did succeed) against Arc Testnet — see the
    // Task 17 controller run and packages/ledger/src/chain/client.ts. QuickNode doesn't share that limit.
    fallbackUrl: 'https://rpc.quicknode.testnet.arc.io',
    userAgent: UA,
  });
  const walletClient = createWalletClient({
    account,
    chain: arcTestnetChain,
    transport: http(env.rpc, { fetchOptions: { headers: { 'User-Agent': UA } } }),
  });
  return { publicClient, walletClient, account };
}

/** Deterministic throwaway recipient i (keys derivable from a public string; testnet only). */
export function spikeRecipient(i: number): Address {
  return privateKeyToAccount(keccak256(stringToHex(`memoline-spike-recipient-${i}`))).address;
}

/** EIP-1559 send with the 20 Gwei floor enforced; waits for the receipt (finality on inclusion). */
export async function sendAndWait(
  walletClient: WalletClient,
  publicClient: PublicClient,
  tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint },
): Promise<TransactionReceipt> {
  const fees = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = clampMaxFeePerGas(fees.maxFeePerGas ?? 0n);
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? FEE.defaultPriorityFeeWei;
  const sender = walletClient.account;
  if (!sender) throw new Error('sendAndWait: walletClient has no account configured');
  const hash = await walletClient.sendTransaction({
    account: sender,
    chain: arcTestnetChain,
    ...tx,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  return publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

export function saveJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}` : v), 2),
  );
}

export const explorer = (hash: Hex) => explorerTxUrl(CHAIN_ID, hash);

/** Runs `fn` over `items` with at most `limit` calls in flight at once (same shape as
 * apps/web's services/imports.ts#mapLimit; duplicated here since scripts must not import Next code). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) continue;
      results[i] = await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** `skip` is only ever set alongside `pass: true` (a skipped test made no assertion, so it can't
 * have failed) — it exists so a skip renders and counts as its own outcome instead of being
 * silently folded into PASS, which would let a broken funding/precondition check "pass" forever. */
export type TestOutcome = { id: string; pass: boolean; skip?: boolean; reason: string };

/**
 * Minimal PASS/FAIL/SKIP harness shared by the acceptance scripts: `record` prints one line as each
 * test finishes, `run` wraps a test body so a thrown error becomes a FAIL instead of aborting the
 * whole script (later tests that depend on an earlier result skip themselves via the `undefined`
 * return), and `summarize` prints the final table and returns whether every test passed — SKIPs are
 * reported and counted separately from PASSes but never affect the exit code, since only `!pass`
 * (an actual FAIL) does.
 */
export function createHarness() {
  const results: TestOutcome[] = [];
  function record(id: string, pass: boolean, reason: string, skip = false): void {
    results.push({ id, pass, skip, reason });
    const glyph = skip ? 'SKIP' : pass ? 'PASS' : 'FAIL';
    console.log(`${glyph} ${id} — ${reason}`);
  }
  async function run<V>(
    id: string,
    fn: () => Promise<{ pass: boolean; reason: string; value?: V; skip?: boolean }>,
  ): Promise<V | undefined> {
    try {
      const outcome = await fn();
      record(id, outcome.pass, outcome.reason, outcome.skip ?? false);
      return outcome.pass ? outcome.value : undefined;
    } catch (e) {
      record(id, false, `threw: ${(e as Error).message}`);
      return undefined;
    }
  }
  function summarize(): boolean {
    console.log('\n--- summary ---');
    for (const r of results) {
      const glyph = r.skip ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
      console.log(`${glyph}  ${r.id.padEnd(6)} ${r.reason}`);
    }
    const skipped = results.filter((r) => r.skip).length;
    const failed = results.filter((r) => !r.pass).length;
    const passed = results.length - skipped - failed;
    console.log(`\n${passed} passed, ${skipped} skipped, ${failed} failed`);
    return failed === 0;
  }
  return { results, record, run, summarize };
}
