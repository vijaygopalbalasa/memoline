/**
 * Spike 0 — prove the primitives on Arc Testnet (SPEC §5). Writes out/spike0-results.json and receipt fixtures.
 * Tests: 1 batch+per-row memo · 2 event order · 3 failure semantics · 4 gas per row · 5 EURC · 6 pre-flight · 6b simulated aggregate3 · 7 EIP-7702 sender.
 */
import { resolve } from 'node:path';
import {
  buildChunkCalldata,
  buildTransferCalldata,
  FEE,
  makePayoutRow,
  mapRevert,
  memoAbi,
  multicall3FromAbi,
  newRunId,
  TOPICS,
} from '@memoline/ledger';
import {
  type Address,
  decodeFunctionResult,
  erc20Abi,
  type Hex,
  keccak256,
  parseEventLogs,
  type TransactionReceipt,
} from 'viem';
import { CHAIN_ID, explorer, saveJson, sendAndWait, spikeRecipient, T, testnetClients } from './lib.js';

const OUT = resolve(import.meta.dirname, 'out');
const FIX = resolve(import.meta.dirname, '../../packages/ledger/test/fixtures');
const { publicClient, walletClient, account } = testnetClients();
const SENDER = account.address;
const results: Record<string, unknown> = {
  chainId: CHAIN_ID,
  sender: SENDER,
  startedAt: new Date().toISOString(),
};

function usdcTransfers(r: TransactionReceipt) {
  return parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: r.logs }).filter(
    (l) => l.address.toLowerCase() === T.systemEmitter.address.toLowerCase(),
  );
}
function memoEvents(r: TransactionReceipt) {
  return parseEventLogs({
    abi: memoAbi,
    logs: r.logs.filter((l) => l.address.toLowerCase() === T.memo.address.toLowerCase()),
  });
}
async function sendBatch(
  rows: ReturnType<typeof makePayoutRow>[],
  token: Address,
  opts: { allowFailure?: boolean; gas?: bigint } = {},
) {
  const data = buildChunkCalldata(
    T.memo.address,
    token,
    { idx: 0, rows },
    { allowFailure: opts.allowFailure ?? false },
  );
  return sendAndWait(walletClient, publicClient, {
    to: T.multicall3From.address,
    data,
    ...(opts.gas ? { gas: opts.gas } : {}),
  });
}
const lower = (a: string) => a.toLowerCase();

function must<V>(value: V | undefined, message: string): V {
  if (value === undefined) throw new Error(message);
  return value;
}

async function main() {
  const bal = await publicClient.readContract({
    address: T.usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [SENDER],
  });
  console.log(`sender ${SENDER} USDC(6dp) balance: ${bal}`);
  if (bal < 1_000_000n) throw new Error('Need ≥ 1 USDC on testnet');

  // ---- Test 1 + 2: 3-row batch with nested memos; log ordering
  {
    const runId = newRunId();
    const rows = [0, 1, 2].map((i) =>
      makePayoutRow(runId, i, spikeRecipient(i), BigInt(1000 + i), `SPIKE-${i}`),
    );
    const receipt = await sendBatch(rows, T.usdc.address);
    const xfers = usdcTransfers(receipt);
    const memos = memoEvents(receipt);
    const memoEv = memos.filter((m) => m.eventName === 'Memo');
    const before = memos.filter((m) => m.eventName === 'BeforeMemo');
    const senderPreserved =
      xfers.every((x) => lower(x.args.from) === lower(SENDER)) &&
      memoEv.every((m) => lower(m.args.sender) === lower(SENDER));
    const hashesOk = rows.every((r) =>
      memoEv.some(
        (m) =>
          m.args.memoId === r.memoId &&
          m.args.callDataHash === keccak256(buildTransferCalldata(r.recipient, r.amount6)),
      ),
    );
    const ordered = rows.every((r) => {
      const m = must(
        memoEv.find((e) => e.args.memoId === r.memoId),
        `test2: no Memo event for row memoId ${r.memoId}`,
      );
      const b = must(
        before.find((e) => e.args.memoIndex === m.args.memoIndex),
        `test2: no BeforeMemo event for memoIndex ${m.args.memoIndex}`,
      );
      const x = must(
        xfers.find((e) => lower(e.args.to) === lower(r.recipient)),
        `test2: no Transfer event to recipient ${r.recipient}`,
      );
      return b.logIndex < x.logIndex && x.logIndex < m.logIndex;
    });
    const usdcContractLogs = receipt.logs.filter(
      (l) => lower(l.address) === lower(T.usdc.address) && l.topics[0] === TOPICS.transfer,
    ).length;
    results.test1_batchMemo = {
      tx: receipt.transactionHash,
      status: receipt.status,
      systemTransfers: xfers.length,
      memoEvents: memoEv.length,
      senderPreserved,
      callDataHashesMatch: hashesOk,
      usdcContractDuplicateLogs: usdcContractLogs,
      gasUsed: receipt.gasUsed,
      explorer: explorer(receipt.transactionHash),
    };
    results.test2_ordering = { bracketOrderHolds: ordered };
    saveJson(resolve(FIX, 'receipt-usdc-3rows.json'), {
      rows,
      receipt,
      runId,
      sender: SENDER,
      chainId: CHAIN_ID,
    });
    console.log('test1/2', results.test1_batchMemo, results.test2_ordering);
  }

  // ---- Test 3: one blocklisted recipient
  {
    const runId = newRunId();
    const rows = [
      makePayoutRow(runId, 0, spikeRecipient(0), 1000n, 'OK-0'),
      makePayoutRow(runId, 1, T.blocklistedTest.address, 1000n, 'BLOCKED'),
      makePayoutRow(runId, 2, spikeRecipient(2), 1000n, 'OK-2'),
    ];
    // 3a allowFailure=false: eth_call must revert; also force an on-chain revert with explicit gas to capture a REVERTED receipt fixture
    const data = buildChunkCalldata(T.memo.address, T.usdc.address, { idx: 0, rows });
    let simRevert: unknown = null;
    try {
      await publicClient.call({ account: SENDER, to: T.multicall3From.address, data });
    } catch (e) {
      simRevert = (e as Error).message.slice(0, 300);
    }
    const reverted = await sendBatch(rows, T.usdc.address, { gas: 600_000n });
    // 3b allowFailure=true: others pay, failed row emits no Memo
    const partial = await sendBatch(rows, T.usdc.address, { allowFailure: true });
    const memosPartial = memoEvents(partial).filter((m) => m.eventName === 'Memo');
    const blockedRow = must(rows[1], 'test3: expected a second row (the blocklisted one)');
    results.test3_failure = {
      allowFalse: {
        simulationReverted: simRevert !== null,
        simMessage: simRevert,
        onchainStatus: reverted.status,
        transfers: usdcTransfers(reverted).length,
        gasUsed: reverted.gasUsed,
        tx: reverted.transactionHash,
      },
      allowTrue: {
        status: partial.status,
        transfers: usdcTransfers(partial).length,
        memoEvents: memosPartial.length,
        failedRowHasMemo: memosPartial.some((m) => m.args.memoId === blockedRow.memoId),
        tx: partial.transactionHash,
      },
    };
    saveJson(resolve(FIX, 'receipt-usdc-reverted.json'), {
      rows,
      receipt: reverted,
      runId,
      sender: SENDER,
      chainId: CHAIN_ID,
    });
    saveJson(resolve(FIX, 'receipt-usdc-allowfailure.json'), {
      rows,
      receipt: partial,
      runId,
      sender: SENDER,
      chainId: CHAIN_ID,
    });
    console.log('test3', results.test3_failure);
  }

  // ---- Test 4: gas per row (estimate 1/10/50/100/200; send 10 and 50 for real fixtures)
  {
    const gas: Record<string, unknown> = {};
    for (const n of [1, 10, 50, 100, 200]) {
      const runId = newRunId();
      const rows = Array.from({ length: n }, (_, i) =>
        makePayoutRow(runId, i, spikeRecipient(i % 60), 1n, `G${i}`),
      );
      const data = buildChunkCalldata(T.memo.address, T.usdc.address, { idx: 0, rows });
      try {
        const est = await publicClient.estimateGas({ account: SENDER, to: T.multicall3From.address, data });
        gas[`rows_${n}`] = { estimate: est, perRow: est / BigInt(n), underCap: est < FEE.txGasCap };
      } catch (e) {
        gas[`rows_${n}`] = { error: (e as Error).message.slice(0, 200) };
      }
    }
    for (const n of [10, 50]) {
      const runId = newRunId();
      const rows = Array.from({ length: n }, (_, i) =>
        makePayoutRow(runId, i, spikeRecipient(i), 1n, `R${i}`),
      );
      const r = await sendBatch(rows, T.usdc.address);
      gas[`sent_${n}`] = {
        tx: r.transactionHash,
        status: r.status,
        gasUsed: r.gasUsed,
        perRow: r.gasUsed / BigInt(n),
        transfers: usdcTransfers(r).length,
      };
      saveJson(resolve(FIX, `receipt-usdc-${n}rows.json`), {
        rows,
        receipt: r,
        runId,
        sender: SENDER,
        chainId: CHAIN_ID,
      });
    }
    results.test4_gas = gas;
    console.log('test4', gas);
  }

  // ---- Test 5: EURC batch (skipped if no EURC)
  {
    const eurc = await publicClient.readContract({
      address: T.eurc.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [SENDER],
    });
    if (eurc >= 2000n) {
      const runId = newRunId();
      const rows = [0, 1].map((i) => makePayoutRow(runId, i, spikeRecipient(i), 1000n, `EUR-${i}`));
      const r = await sendBatch(rows, T.eurc.address);
      const eurcLogs = r.logs.filter(
        (l) => lower(l.address) === lower(T.eurc.address) && l.topics[0] === TOPICS.transfer,
      ).length;
      const sysLogs = usdcTransfers(r).length;
      results.test5_eurc = {
        tx: r.transactionHash,
        status: r.status,
        eurcContractTransfers: eurcLogs,
        systemEmitterTransfers: sysLogs,
        feePaidInUsdcNative18: r.gasUsed * r.effectiveGasPrice,
      };
      saveJson(resolve(FIX, 'receipt-eurc-2rows.json'), {
        rows,
        receipt: r,
        runId,
        sender: SENDER,
        chainId: CHAIN_ID,
      });
    } else
      results.test5_eurc = {
        skipped: true,
        reason: `EURC balance ${eurc} < 2000 — fund from faucet.circle.com`,
      };
    console.log('test5', results.test5_eurc);
  }

  // ---- Test 6: pre-flight eth_call of a direct transfer to the blocklisted address; 6b simulated aggregate3
  {
    let revertData: Hex | undefined;
    let msg = '';
    try {
      await publicClient.call({
        account: SENDER,
        to: T.usdc.address,
        data: buildTransferCalldata(T.blocklistedTest.address, 1n),
      });
    } catch (e) {
      const err = e as { cause?: { data?: Hex; raw?: Hex }; message: string; data?: Hex };
      revertData = err.data ?? err.cause?.data ?? err.cause?.raw;
      msg = err.message.slice(0, 300);
    }
    const mapped = mapRevert(revertData, { recipient: T.blocklistedTest.address, blocklistedHint: true });
    const runId = newRunId();
    const rows = [
      makePayoutRow(runId, 0, spikeRecipient(0), 1n, 'A'),
      makePayoutRow(runId, 1, T.blocklistedTest.address, 1n, 'B'),
    ];
    const sim = await publicClient.call({
      account: SENDER,
      to: T.multicall3From.address,
      data: buildChunkCalldata(T.memo.address, T.usdc.address, { idx: 0, rows }, { allowFailure: true }),
    });
    const simData = must(sim.data, 'test6: simulated aggregate3 call returned no data');
    const decoded = decodeFunctionResult({
      abi: multicall3FromAbi,
      functionName: 'aggregate3',
      data: simData,
    });
    results.test6_preflight = {
      directCallReverted: msg !== '',
      revertData,
      mappedCode: mapped.code,
      message: msg,
      simulatedAggregate3: decoded.map((d) => ({ success: d.success, returnData: d.returnData })),
    };
    console.log('test6', results.test6_preflight);
  }

  // ---- Test 7: EIP-7702 delegated sender (opt-out with SPIKE_SKIP_7702=1). Delegates to a codeless address, sends one memo, then revokes.
  if (process.env.SPIKE_SKIP_7702 !== '1') {
    const runId = newRunId();
    const row = makePayoutRow(runId, 0, spikeRecipient(0), 1n, 'SEVEN');
    const data = buildChunkCalldata(T.memo.address, T.usdc.address, { idx: 0, rows: [row] });
    const out: Record<string, unknown> = {};
    try {
      // Delegate to a codeless address: the account carries a 7702 designator (what we test) without
      // exposing any executable code to third parties while delegated.
      const auth = await walletClient.signAuthorization({
        account,
        contractAddress: '0x000000000000000000000000000000000000dEaD',
        executor: 'self',
      });
      const hash = await walletClient.sendTransaction({
        account,
        to: T.multicall3From.address,
        data,
        authorizationList: [auth],
        maxFeePerGas: 25_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      });
      const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const code = await publicClient.getCode({ address: SENDER });
      out.delegatedSend = {
        tx: hash,
        status: r.status,
        codeAfter: code,
        memoEvents: memoEvents(r).filter((m) => m.eventName === 'Memo').length,
        transfers: usdcTransfers(r).length,
      };
      // second send while delegated (no new auth) — the steady-state 7702 case
      const r2 = await sendBatch([makePayoutRow(runId, 1, spikeRecipient(1), 1n, 'SEVEN-2')], T.usdc.address);
      out.steadyState = {
        tx: r2.transactionHash,
        status: r2.status,
        memoEvents: memoEvents(r2).filter((m) => m.eventName === 'Memo').length,
      };
    } catch (e) {
      out.error = (e as Error).message.slice(0, 400);
    } finally {
      try {
        const revoke = await walletClient.signAuthorization({
          account,
          contractAddress: '0x0000000000000000000000000000000000000000',
          executor: 'self',
        });
        const hash = await walletClient.sendTransaction({
          account,
          to: SENDER,
          authorizationList: [revoke],
          maxFeePerGas: 25_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        out.revoked = { tx: hash, codeAfter: await publicClient.getCode({ address: SENDER }) };
      } catch (e) {
        out.revokeError = (e as Error).message.slice(0, 300);
      }
    }
    results.test7_eip7702 = out;
    console.log('test7', out);
  } else results.test7_eip7702 = { skipped: true };

  results.finishedAt = new Date().toISOString();
  saveJson(resolve(OUT, 'spike0-results.json'), results);
  console.log(`\nwrote ${resolve(OUT, 'spike0-results.json')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
