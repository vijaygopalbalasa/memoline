/**
 * Property tests for the double-count guard in reconcileReceipt.
 *
 * On Arc every native USDC move logs a Transfer from the system emitter (18 dp), and an ERC-20
 * transfer() of USDC logs a second Transfer from the USDC contract (6 dp) for the same money.
 * A naive reader counts both. These properties build synthetic receipts shaped like the recorded
 * testnet fixtures (BeforeMemo(i), value Transfer, duplicate Transfer, Memo(i) per row) with
 * unrelated logs from other contracts interleaved anywhere, and check that each payment becomes
 * exactly one ledger line, matched to its own memo, and that the duplicate never counts.
 */
import fc from 'fast-check';
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  type Log,
  type TransactionReceipt,
  toHex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ADDRESSES,
  buildTransferCalldata,
  type ChainId,
  makePayoutRow,
  memoAbi,
  type PayoutRow,
  reconcileReceipt,
  SCALE_12,
  type Token,
  tokenAddress,
} from '../src/index.js';

const NUM_RUNS = 200;
const TX_HASH: Hex = `0x${'7a'.repeat(32)}`;
const BLOCK_HASH: Hex = `0x${'b1'.repeat(32)}`;
const BLOCK_NUMBER = 62_950_000n;
const BLOCK_TIME = 1_789_000_000;

type ReceiptLog = Log<bigint, number, false>;
type UnplacedLog = Omit<ReceiptLog, 'logIndex'>;

// ---------- arbitraries ----------

/** Every address the reconciler treats specially, on both networks. Noise never comes from these. */
const RESERVED = new Set(
  Object.values(ADDRESSES).flatMap((net) => Object.values(net).map((s) => s.address.toLowerCase())),
);

const addressArb = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => getAddress(toHex(b)));
const outsiderArb = addressArb.filter((a) => !RESERVED.has(a.toLowerCase()));

/** A small shared pool so the same recipient often appears on several rows. */
const POOL: Address[] = [
  '0x7e30c418d14698db76691d054db0f4422e19e804',
  '0x02708130924aea7c8a85953ec14d5a8f5679d04b',
  '0x83cacde5883f002c2a70e740aaf447b0b24145dc',
].map((x) => getAddress(x));
const recipientArb = fc.oneof(fc.constantFrom(...POOL), outsiderArb);

/** Common amounts repeat across rows, so two rows can pay the same person the same amount. */
const amount6Arb = fc.oneof(
  fc.constantFrom(1n, 1_000n, 1_000_000n),
  fc.bigInt({ min: 1n, max: 1_000_000_000_000_000n }),
);

const rowSpecArb = fc.record({
  recipient: recipientArb,
  amount6: amount6Arb,
  reference: fc.stringMatching(/^[A-Za-z0-9._:-]{1,24}$/),
  /** The recorded fixtures put the system-emitter log first; the guard must not depend on that. */
  duplicateFirst: fc.boolean(),
});

const hex32Arb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => toHex(b));

type NoiseSpec =
  | { kind: 'decoy'; emitter: Address; rowPick: number; in18dp: boolean; at: number }
  | { kind: 'other'; emitter: Address; topics: Hex[]; data: Hex; at: number };

const noiseArb: fc.Arbitrary<NoiseSpec> = fc.oneof(
  // A Transfer from some other token contract that copies a real payment's sender, recipient and
  // value exactly. The worst case: indistinguishable except for which contract emitted it.
  fc.record({
    kind: fc.constant('decoy' as const),
    emitter: outsiderArb,
    rowPick: fc.nat(),
    in18dp: fc.boolean(),
    at: fc.nat(),
  }),
  fc.record({
    kind: fc.constant('other' as const),
    emitter: outsiderArb,
    topics: fc.array(hex32Arb, { minLength: 0, maxLength: 4 }),
    data: fc.uint8Array({ minLength: 0, maxLength: 96 }).map((b) => toHex(b)),
    at: fc.nat(),
  }),
);

const planArb = fc.record({
  chainId: fc.constantFrom<ChainId>(5042, 5042002),
  sender: outsiderArb,
  runId: fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  firstRowIndex: fc.nat({ max: 10_000 }),
  firstMemoIndex: fc.bigInt({ min: 0n, max: 10n ** 12n }),
  rows: fc.array(rowSpecArb, { minLength: 1, maxLength: 30 }),
  noise: fc.array(noiseArb, { minLength: 0, maxLength: 40 }),
  firstLogIndex: fc.nat({ max: 500 }),
  gaps: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 16 }),
  gasUsed: fc.bigInt({ min: 21_000n, max: 16_777_216n }),
  effectiveGasPrice: fc.bigInt({ min: 20_000_000_000n, max: 1_000_000_000_000n }),
});
type Plan = typeof planArb extends fc.Arbitrary<infer T> ? T : never;

// ---------- log builders ----------

function flatTopics(topics: readonly (Hex | Hex[] | null)[]): [Hex, ...Hex[]] {
  const flat = topics.map((t) => {
    if (typeof t !== 'string') throw new Error('expected only single-value topics');
    return t;
  });
  const [head, ...rest] = flat;
  if (!head) throw new Error('expected an event selector topic');
  return [head, ...rest];
}

function unplaced(address: Address, topics: [Hex, ...Hex[]] | [], data: Hex): UnplacedLog {
  return {
    address,
    topics,
    data,
    blockHash: BLOCK_HASH,
    blockNumber: BLOCK_NUMBER,
    transactionHash: TX_HASH,
    transactionIndex: 8,
    removed: false,
  };
}

function transferLog(emitter: Address, from: Address, to: Address, value: bigint): UnplacedLog {
  return unplaced(
    emitter,
    flatTopics(encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } })),
    encodeAbiParameters([{ type: 'uint256' }], [value]),
  );
}

function beforeMemoLog(memo: Address, memoIndex: bigint): UnplacedLog {
  return unplaced(
    memo,
    flatTopics(encodeEventTopics({ abi: memoAbi, eventName: 'BeforeMemo', args: { memoIndex } })),
    '0x',
  );
}

function memoLog(memo: Address, sender: Address, target: Address, row: PayoutRow, memoIndex: bigint) {
  return unplaced(
    memo,
    flatTopics(
      encodeEventTopics({
        abi: memoAbi,
        eventName: 'Memo',
        args: { sender, target, memoId: row.memoId },
      }),
    ),
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes' }, { type: 'uint256' }],
      [keccak256(buildTransferCalldata(row.recipient, row.amount6)), row.memoData, memoIndex],
    ),
  );
}

type Role = 'beforeMemo' | 'value' | 'duplicate' | 'memo';
type Slot = { beforeMemo: number; value: number; duplicate: number | null; memo: number; memoIndex: bigint };

type Built = {
  receipt: TransactionReceipt;
  rows: PayoutRow[];
  /** Log positions of each row's own logs, in row order. */
  slots: Slot[];
  /** Sum of the values carried by the value-bearing Transfer logs (18 dp for USDC, 6 dp for EURC). */
  valueLogTotal: bigint;
  /** Log indices of the USDC contract's own Transfer logs (empty for EURC). */
  duplicateLogIndexes: number[];
};

/**
 * Lays out one Multicall3From transaction the way Arc emits it. Per row: BeforeMemo(i), the value
 * Transfer, the duplicate USDC-contract Transfer (USDC only), then Memo(i). Noise logs from other
 * contracts are inserted at arbitrary positions, and log indices are strictly increasing with gaps.
 */
function buildReceipt(plan: Plan, token: Token): Built {
  const a = ADDRESSES[plan.chainId];
  const tokenAddr = tokenAddress(plan.chainId, token);
  const isUsdc = token === 'USDC';

  const rows = plan.rows.map((spec, i) =>
    makePayoutRow(plan.runId, plan.firstRowIndex + i, spec.recipient, spec.amount6, spec.reference),
  );

  type Pending = { log: UnplacedLog; tag: { row: number; role: Role } | null };
  const ordered: Pending[] = [];
  let valueLogTotal = 0n;

  rows.forEach((row, i) => {
    const spec = plan.rows[i];
    if (!spec) throw new Error(`row spec ${i} missing`);
    const memoIndex = plan.firstMemoIndex + BigInt(i);
    const tag = (role: Role) => ({ row: i, role });

    const value = isUsdc ? row.amount6 * SCALE_12 : row.amount6;
    valueLogTotal += value;
    const valueEmitter = isUsdc ? a.systemEmitter.address : tokenAddr;
    const valueLog: Pending = {
      log: transferLog(valueEmitter, plan.sender, row.recipient, value),
      tag: tag('value'),
    };

    ordered.push({ log: beforeMemoLog(a.memo.address, memoIndex), tag: tag('beforeMemo') });
    if (isUsdc) {
      const duplicate: Pending = {
        log: transferLog(a.usdc.address, plan.sender, row.recipient, row.amount6),
        tag: tag('duplicate'),
      };
      ordered.push(...(spec.duplicateFirst ? [duplicate, valueLog] : [valueLog, duplicate]));
    } else {
      ordered.push(valueLog);
    }
    ordered.push({ log: memoLog(a.memo.address, plan.sender, tokenAddr, row, memoIndex), tag: tag('memo') });
  });

  for (const n of plan.noise) {
    let log: UnplacedLog;
    if (n.kind === 'decoy') {
      const target = rows[n.rowPick % rows.length];
      if (!target) throw new Error('decoy target missing');
      const value = n.in18dp ? target.amount6 * SCALE_12 : target.amount6;
      log = transferLog(n.emitter, plan.sender, target.recipient, value);
    } else {
      const [head, ...rest] = n.topics;
      log = unplaced(n.emitter, head ? [head, ...rest] : [], n.data);
    }
    ordered.splice(n.at % (ordered.length + 1), 0, { log, tag: null });
  }

  const logs: ReceiptLog[] = [];
  const found = rows.map(() => ({}) as Partial<Record<Role, number>>);
  let logIndex = plan.firstLogIndex;
  ordered.forEach((p, k) => {
    logs.push({ ...p.log, logIndex });
    if (p.tag) {
      const f = found[p.tag.row];
      if (f) f[p.tag.role] = logIndex;
    }
    logIndex += plan.gaps[k % plan.gaps.length] ?? 1;
  });

  const slots: Slot[] = found.map((f, i) => {
    if (f.beforeMemo === undefined || f.value === undefined || f.memo === undefined)
      throw new Error(`row ${i} logs were not all placed`);
    return {
      beforeMemo: f.beforeMemo,
      value: f.value,
      duplicate: f.duplicate ?? null,
      memo: f.memo,
      memoIndex: plan.firstMemoIndex + BigInt(i),
    };
  });

  const receipt: TransactionReceipt = {
    type: 'eip1559',
    status: 'success',
    blockHash: BLOCK_HASH,
    blockNumber: BLOCK_NUMBER,
    contractAddress: null,
    cumulativeGasUsed: plan.gasUsed,
    effectiveGasPrice: plan.effectiveGasPrice,
    from: plan.sender,
    gasUsed: plan.gasUsed,
    logs,
    logsBloom: `0x${'00'.repeat(256)}`,
    to: a.multicall3From.address,
    transactionHash: TX_HASH,
    transactionIndex: 8,
  };

  return {
    receipt,
    rows,
    slots,
    valueLogTotal,
    duplicateLogIndexes: slots.flatMap((s) => (s.duplicate === null ? [] : [s.duplicate])),
  };
}

const ctxFor = (plan: Plan, token: Token, rows: PayoutRow[]) => ({
  chainId: plan.chainId,
  sender: plan.sender,
  token,
  chunk: { idx: 0, rows },
  runId: plan.runId,
  blockTime: BLOCK_TIME,
});

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`index ${i} missing`);
  return x;
}

// ---------- properties ----------

describe('reconcileReceipt double-count guard (property)', () => {
  it('USDC: one entry per row from the system emitter, matched to its own memo; the USDC-contract duplicate never counts', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const b = buildReceipt(plan, 'USDC');
        const n = b.rows.length;
        const r = reconcileReceipt(b.receipt, ctxFor(plan, 'USDC', b.rows));

        // Exactly N entries, every row reconciled, nothing left over.
        expect(r.entries).toHaveLength(n);
        expect(r.rows.map((x) => x.status)).toEqual(b.rows.map(() => 'RECONCILED'));
        expect(r.checks).toEqual({
          matchedCount: n,
          expectedCount: n,
          sumOk: true,
          unexplainedTransfers: 0,
          duplicateUsdcContractLogs: n,
        });

        // The entries add up to what the system emitter moved, in both scales.
        const sumNative18 = r.entries.reduce((s, e) => s + (e.amountNative18 ?? 0n), 0n);
        const sumAmount6 = r.entries.reduce((s, e) => s + e.amount6, 0n);
        expect(sumNative18).toBe(b.valueLogTotal);
        expect(sumAmount6 * SCALE_12).toBe(b.valueLogTotal);

        // Every entry is matched to its own memo and its own system-emitter log.
        r.entries.forEach((e, i) => {
          const row = at(b.rows, i);
          const slot = at(b.slots, i);
          expect(e.memoId).toBe(row.memoId);
          expect(e.memoIndex).toBe(slot.memoIndex);
          expect(e.logIndex).toBe(slot.value);
          expect(e.logIndex).toBeGreaterThan(slot.beforeMemo);
          expect(e.logIndex).toBeLessThan(slot.memo);
          expect(e.counterparty).toBe(row.recipient);
          expect(e.amount6).toBe(row.amount6);
          expect(e.amountNative18).toBe(row.amount6 * SCALE_12);
          expect(e.reference).toBe(row.reference);
          expect(e.sourceId).toBe(`${plan.runId}:${row.rowIndex}`);
          expect(e.token).toBe('USDC');
        });

        // No log is used twice, and no entry points at a USDC-contract duplicate.
        const used = r.entries.map((e) => e.logIndex);
        expect(new Set(used).size).toBe(n);
        const duplicates = new Set(b.duplicateLogIndexes);
        expect(used.filter((i) => duplicates.has(i))).toEqual([]);

        // The fee is split across the entries and ties out exactly.
        expect(r.chunkFeeNative18).toBe(plan.gasUsed * plan.effectiveGasPrice);
        expect(r.entries.reduce((s, e) => s + e.feeNative18, 0n)).toBe(r.chunkFeeNative18);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('USDC: with the system-emitter logs removed, the USDC-contract logs alone pay nothing', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const b = buildReceipt(plan, 'USDC');
        const valueIndexes = new Set(b.slots.map((s) => s.value));
        const receipt = { ...b.receipt, logs: b.receipt.logs.filter((l) => !valueIndexes.has(l.logIndex)) };
        const r = reconcileReceipt(receipt, ctxFor(plan, 'USDC', b.rows));

        expect(r.entries).toEqual([]);
        expect(r.rows.every((x) => x.status === 'EXCEPTION' && /found 0/.test(x.reason ?? ''))).toBe(true);
        expect(r.checks.matchedCount).toBe(0);
        expect(r.checks.unexplainedTransfers).toBe(0);
        expect(r.checks.duplicateUsdcContractLogs).toBe(b.rows.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('EURC: one entry per row from the EURC contract log, with no native value', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const b = buildReceipt(plan, 'EURC');
        const n = b.rows.length;
        const eurc = tokenAddress(plan.chainId, 'EURC');
        const r = reconcileReceipt(b.receipt, ctxFor(plan, 'EURC', b.rows));

        // Only the EURC contract emits value Transfers here: no system emitter, no USDC contract.
        const transferEmitters = new Set(
          b.slots.map((s) => b.receipt.logs.find((l) => l.logIndex === s.value)?.address.toLowerCase()),
        );
        expect([...transferEmitters]).toEqual([eurc.toLowerCase()]);
        expect(
          b.receipt.logs.some(
            (l) =>
              l.address.toLowerCase() === ADDRESSES[plan.chainId].systemEmitter.address.toLowerCase() ||
              l.address.toLowerCase() === ADDRESSES[plan.chainId].usdc.address.toLowerCase(),
          ),
        ).toBe(false);

        expect(r.entries).toHaveLength(n);
        expect(r.rows.map((x) => x.status)).toEqual(b.rows.map(() => 'RECONCILED'));
        expect(r.checks).toEqual({
          matchedCount: n,
          expectedCount: n,
          sumOk: true,
          unexplainedTransfers: 0,
          duplicateUsdcContractLogs: 0,
        });

        // Amounts come from the EURC log (6 dp), and there is no native value.
        expect(r.entries.reduce((s, e) => s + e.amount6, 0n)).toBe(b.valueLogTotal);
        r.entries.forEach((e, i) => {
          const row = at(b.rows, i);
          const slot = at(b.slots, i);
          expect(e.amountNative18).toBeNull();
          expect(e.token).toBe('EURC');
          expect(e.amount6).toBe(row.amount6);
          expect(e.logIndex).toBe(slot.value);
          expect(e.memoId).toBe(row.memoId);
          expect(e.memoIndex).toBe(slot.memoIndex);
          expect(e.counterparty).toBe(row.recipient);
        });
        expect(new Set(r.entries.map((e) => e.logIndex)).size).toBe(n);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
