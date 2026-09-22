import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import type { TransactionReceipt } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ADDRESSES,
  allocateFee,
  makePayoutRow,
  type PayoutRow,
  reconcileReceipt,
  TOPICS,
} from '../src/index.js';

type Fixture = {
  rows: PayoutRow[];
  receipt: TransactionReceipt;
  runId: string;
  sender: `0x${string}`;
  chainId: 5042002;
};

const revive = (_k: string, v: unknown) =>
  typeof v === 'string' &&
  /^0x[0-9a-f]+$/.test(v) &&
  !/^0x[0-9a-f]{40}$/.test(v) &&
  !/^0x[0-9a-f]{64}$/.test(v) &&
  v.length < 30
    ? BigInt(v)
    : v;

function load(name: string): Fixture {
  const f = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
    revive,
  ) as Fixture;
  f.rows = f.rows.map((r) => ({ ...r, amount6: BigInt(r.amount6) }));
  f.receipt.gasUsed = BigInt(f.receipt.gasUsed);
  f.receipt.effectiveGasPrice = BigInt(f.receipt.effectiveGasPrice);
  f.receipt.blockNumber = BigInt(f.receipt.blockNumber);
  return f;
}

function rowAt(rows: PayoutRow[], i: number): PayoutRow {
  const row = rows[i];
  if (!row) throw new Error(`fixture row ${i} missing`);
  return row;
}

const ctxOf = (f: Fixture, token: 'USDC' | 'EURC' = 'USDC') => ({
  chainId: f.chainId,
  sender: f.sender,
  token,
  chunk: { idx: 0, rows: f.rows },
  runId: f.runId,
  blockTime: 1_789_000_000,
});

describe('allocateFee', () => {
  it('sums exactly, remainder to the first row', () => {
    expect(allocateFee(10n, 3)).toEqual([4n, 3n, 3n]);
    expect(allocateFee(0n, 2)).toEqual([0n, 0n]);
    expect(allocateFee(5n, 0)).toEqual([]);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 18n }),
        fc.integer({ min: 1, max: 200 }),
        (t, n) => allocateFee(t, n).reduce((a, b) => a + b, 0n) === t,
      ),
    );
  });
});

describe('reconcileReceipt (USDC 3-row fixture)', () => {
  const f = load('receipt-usdc-3rows.json');

  it('every reconciled entry carries the row reference — the memo line becomes the ledger line', () => {
    const f = load('receipt-usdc-3rows.json');
    const r = reconcileReceipt(f.receipt, ctxOf(f));
    expect(r.entries.map((e) => e.reference)).toEqual(f.rows.map((row) => row.reference));
  });
  it('fixture contains BOTH emitters (the trap is real)', () => {
    const sys = f.receipt.logs.filter(
      (l) =>
        l.address.toLowerCase() === ADDRESSES[5042002].systemEmitter.address.toLowerCase() &&
        l.topics[0] === TOPICS.transfer,
    );
    const usdc = f.receipt.logs.filter(
      (l) =>
        l.address.toLowerCase() === ADDRESSES[5042002].usdc.address.toLowerCase() &&
        l.topics[0] === TOPICS.transfer,
    );
    expect(sys.length).toBe(3);
    expect(usdc.length).toBe(3);
  });

  it('writes exactly one entry per row, never from the USDC-contract log', () => {
    const r = reconcileReceipt(f.receipt, ctxOf(f));
    expect(r.rows.every((x) => x.status === 'RECONCILED')).toBe(true);
    expect(r.entries).toHaveLength(3);
    expect(r.checks.duplicateUsdcContractLogs).toBe(3);
    expect(r.checks.unexplainedTransfers).toBe(0);
    for (const [i, e] of r.entries.entries()) {
      const row = rowAt(f.rows, i);
      expect(e.amount6).toBe(row.amount6);
      expect(e.amountNative18).toBe(row.amount6 * 10n ** 12n);
      expect(e.counterparty.toLowerCase()).toBe(row.recipient.toLowerCase());
      expect(e.memoId).toBe(row.memoId);
      expect(e.direction).toBe('out');
      expect(e.token).toBe('USDC');
      expect(e.sourceType).toBe('payout');
    }
    const fee = f.receipt.gasUsed * f.receipt.effectiveGasPrice;
    expect(r.chunkFeeNative18).toBe(fee);
    expect(r.entries.reduce((a, e) => a + e.feeNative18, 0n)).toBe(fee);
  });

  it('a row whose memo is missing becomes an EXCEPTION with a precise reason (tampered expectation)', () => {
    const rows = f.rows.map((r, i) =>
      i === 1 ? { ...r, memoId: `0x${'ab'.repeat(32)}` as `0x${string}` } : r,
    );
    const r = reconcileReceipt(f.receipt, { ...ctxOf(f), chunk: { idx: 0, rows } });
    expect(r.rows[1]?.status).toBe('EXCEPTION');
    expect(r.rows[1]?.reason).toMatch(/no Memo event/);
    expect(r.entries).toHaveLength(2);
  });

  it('a wrong amount or recipient in the expectation is an EXCEPTION, and the unexplained transfer is counted', () => {
    const rows = f.rows.map((r, i) => (i === 0 ? { ...r, amount6: r.amount6 + 1n } : r));
    const r = reconcileReceipt(f.receipt, { ...ctxOf(f), chunk: { idx: 0, rows } });
    expect(r.rows[0]?.status).toBe('EXCEPTION');
    expect(r.rows[0]?.reason).toMatch(/callDataHash/);
    expect(r.checks.unexplainedTransfers).toBe(1);
  });

  it('a reverted receipt yields no entries and every row EXCEPTION', () => {
    const g = load('receipt-usdc-reverted.json');
    const r = reconcileReceipt(g.receipt, ctxOf(g));
    expect(r.entries).toHaveLength(0);
    expect(r.rows.every((x) => x.status === 'EXCEPTION' && /reverted/.test(x.reason ?? ''))).toBe(true);
    expect(r.chunkFeeNative18).toBe(g.receipt.gasUsed * g.receipt.effectiveGasPrice);
  });

  it('allowFailure=true receipt: paid rows reconcile, the blocklisted row is an EXCEPTION', () => {
    const g = load('receipt-usdc-allowfailure.json');
    const r = reconcileReceipt(g.receipt, ctxOf(g));
    expect(r.rows.map((x) => x.status)).toEqual(['RECONCILED', 'EXCEPTION', 'RECONCILED']);
  });

  it('50-row receipt reconciles fully and fees tie out', () => {
    const g = load('receipt-usdc-50rows.json');
    const r = reconcileReceipt(g.receipt, ctxOf(g));
    expect(r.entries).toHaveLength(50);
    expect(r.entries.reduce((a, e) => a + e.feeNative18, 0n)).toBe(r.chunkFeeNative18);
  });

  it('wrong sender in ctx is rejected for every row (no cross-run adoption)', () => {
    const r = reconcileReceipt(f.receipt, {
      ...ctxOf(f),
      sender: '0x000000000000000000000000000000000000dEaD',
    });
    expect(r.entries).toHaveLength(0);
    expect(r.rows[0]?.reason).toMatch(/sender/);
  });
});

describe('reconcileReceipt (EURC 2-row fixture)', () => {
  // A real Arc Testnet EURC payout (tx 0x01602101…ca062), captured by scripts/testnet/capture-receipt.ts.
  // Loaded per test, so a missing fixture fails these tests loudly without hiding the ones above.
  const eurc = () => load('receipt-eurc-2rows.json');

  it('uses the EURC contract log and no system-emitter value', () => {
    const g = eurc();
    const logsFrom = (address: string) =>
      g.receipt.logs.filter(
        (l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === TOPICS.transfer,
      );
    expect(logsFrom(ADDRESSES[5042002].eurc.address)).toHaveLength(2);
    expect(logsFrom(ADDRESSES[5042002].systemEmitter.address)).toHaveLength(0);
    expect(logsFrom(ADDRESSES[5042002].usdc.address)).toHaveLength(0);

    const r = reconcileReceipt(g.receipt, ctxOf(g, 'EURC'));
    expect(r.rows.every((x) => x.status === 'RECONCILED')).toBe(true);
    expect(r.entries).toHaveLength(2);
    expect(r.checks.unexplainedTransfers).toBe(0);
    expect(r.checks.duplicateUsdcContractLogs).toBe(0);
    expect(r.checks.sumOk).toBe(true);
    for (const [i, e] of r.entries.entries()) {
      const row = rowAt(g.rows, i);
      expect(e.token).toBe('EURC');
      expect(e.amountNative18).toBeNull();
      expect(e.amount6).toBe(row.amount6);
      expect(e.counterparty.toLowerCase()).toBe(row.recipient.toLowerCase());
      expect(e.reference).toBe(row.reference);
      expect(e.memoId).toBe(row.memoId);
    }
    const fee = g.receipt.gasUsed * g.receipt.effectiveGasPrice;
    expect(r.chunkFeeNative18).toBe(fee);
    expect(r.entries.reduce((a, e) => a + e.feeNative18, 0n)).toBe(fee);
  });

  it('the fixture rows are exactly what Memoline builds for that run', () => {
    const g = eurc();
    for (const row of g.rows) {
      expect(makePayoutRow(g.runId, row.rowIndex, row.recipient, row.amount6, row.reference)).toEqual(row);
    }
  });

  it('the same receipt read as USDC matches nothing (the memo target is EURC)', () => {
    const g = eurc();
    const r = reconcileReceipt(g.receipt, ctxOf(g, 'USDC'));
    expect(r.entries).toHaveLength(0);
    expect(r.rows.every((x) => x.status === 'EXCEPTION' && /not the token/.test(x.reason ?? ''))).toBe(true);
  });
});
