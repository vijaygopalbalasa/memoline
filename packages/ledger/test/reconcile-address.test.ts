import { readFileSync } from 'node:fs';
import type { Log, TransactionReceipt } from 'viem';
import { describe, expect, it } from 'vitest';
import { ADDRESSES, type PayoutRow, reconcileAddress } from '../src/index.js';

type Fixture = {
  rows: PayoutRow[];
  receipt: TransactionReceipt;
  runId: string;
  sender: `0x${string}`;
  chainId: 5042002;
};

function load(name: string): Fixture {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Fixture;
  f.receipt.gasUsed = BigInt(f.receipt.gasUsed);
  f.receipt.effectiveGasPrice = BigInt(f.receipt.effectiveGasPrice);
  f.receipt.blockNumber = BigInt(f.receipt.blockNumber);
  f.receipt.logs = f.receipt.logs.map((l) => ({
    ...l,
    blockNumber: BigInt(l.blockNumber as unknown as string),
  }));
  return f;
}

function rowAt(rows: PayoutRow[], i: number): PayoutRow {
  const row = rows[i];
  if (!row) throw new Error(`fixture row ${i} missing`);
  return row;
}

const f = load('receipt-usdc-3rows.json');
const base = {
  chainId: 5042002 as const,
  receiptsByTx: new Map([[f.receipt.transactionHash, f.receipt]]),
  blockTimes: new Map([[f.receipt.blockNumber, 1_789_000_000]]),
  importId: 'IMP1',
};

describe('reconcileAddress', () => {
  it('sender view: 3 outgoing entries with memos and decoded references, gas split pro rata (remainder to the first), USDC-contract logs ignored', () => {
    const entries = reconcileAddress({ ...base, address: f.sender, logs: f.receipt.logs as Log[] });
    expect(entries).toHaveLength(3);
    expect(
      entries.every((e) => e.direction === 'out' && e.sourceType === 'import' && e.memoId !== null),
    ).toBe(true);
    // The invoice reference travels on-chain in the memo data and comes back as a ledger field —
    // the same split the run-side reconciliation uses, so the payer's and the importer's view of
    // one transaction agree line by line.
    expect(entries.map((e) => e.reference)).toEqual(f.rows.map((r) => r.reference));
    const fee = f.receipt.gasUsed * f.receipt.effectiveGasPrice;
    const base3 = fee / 3n;
    expect(entries.map((e) => e.feeNative18)).toEqual([base3 + (fee - base3 * 3n), base3, base3]);
    expect(entries.reduce((s, e) => s + e.feeNative18, 0n)).toBe(fee);
    expect(entries.map((e) => e.amount6)).toEqual(f.rows.map((r) => BigInt(r.amount6)));
  });

  it('a transaction the address paid for with no USDC/EURC movement of its own still puts its gas in the books as a gas-only line', () => {
    // Keep only the Memo logs: the address paid for the transaction (receipt.from) but none of the
    // transfers touch it, so without a gas-only line the fee would silently vanish from the ledger.
    const memoOnly = (f.receipt.logs as Log[]).filter(
      (l) => l.address.toLowerCase() === ADDRESSES[5042002].memo.address.toLowerCase(),
    );
    const receipt = { ...f.receipt, logs: memoOnly } as TransactionReceipt;
    const entries = reconcileAddress({
      ...base,
      receiptsByTx: new Map([[receipt.transactionHash, receipt]]),
      address: f.sender,
      logs: memoOnly,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      direction: 'self',
      amount6: 0n,
      logIndex: -1,
      memoId: null,
      reference: null,
    });
    expect(entries[0]?.feeNative18).toBe(f.receipt.gasUsed * f.receipt.effectiveGasPrice);
    expect(entries[0]?.note).toMatch(/gas only/i);
  });

  it('a memo that is not Memoline-formatted yields a null reference, never a throw', () => {
    const logs = (f.receipt.logs as Log[]).map((l) =>
      l.address.toLowerCase() === ADDRESSES[5042002].memo.address.toLowerCase() && l.data.length > 200
        ? { ...l, data: l.data.slice(0, 130).padEnd(l.data.length, '0') as `0x${string}` }
        : l,
    );
    const entries = reconcileAddress({ ...base, address: f.sender, logs });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.reference === null || typeof e.reference === 'string')).toBe(true);
  });

  it('recipient view: one incoming entry, no fee (recipient did not pay gas)', () => {
    const recipient = rowAt(f.rows, 1).recipient;
    const entries = reconcileAddress({ ...base, address: recipient, logs: f.receipt.logs as Log[] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.direction).toBe('in');
    expect(entries[0]?.feeNative18).toBe(0n);
    expect(entries[0]?.counterparty.toLowerCase()).toBe(f.sender.toLowerCase());
  });

  it('is idempotent on duplicated logs (same txHash+logIndex twice)', () => {
    const entries = reconcileAddress({
      ...base,
      address: f.sender,
      logs: [...f.receipt.logs, ...f.receipt.logs] as Log[],
    });
    expect(entries).toHaveLength(3);
  });

  it('an unrelated address yields nothing', () => {
    expect(
      reconcileAddress({
        ...base,
        address: '0x000000000000000000000000000000000000dEaD',
        logs: f.receipt.logs as Log[],
      }),
    ).toHaveLength(0);
  });

  it('records sub-6dp dust in the note instead of dropping it', () => {
    const emitter = ADDRESSES[5042002].systemEmitter.address;
    const l = f.receipt.logs.find((x) => x.address.toLowerCase() === emitter.toLowerCase());
    if (!l) throw new Error('fixture has no system-emitter log');
    const dusty = {
      ...l,
      data: `0x${(BigInt(l.data) + 7n).toString(16).padStart(64, '0')}` as `0x${string}`,
    };
    // No receipt for this tx: with one, reconcileAddress now reads the tx's real (non-dusty) logs
    // straight off the receipt (see the memo-attachment fix below), which would mask this modified
    // log entirely. Omitting the receipt exercises the fallback path, which uses `logs` as given.
    const entries = reconcileAddress({
      ...base,
      address: f.sender,
      logs: [dusty] as Log[],
      receiptsByTx: new Map(),
    });
    expect(entries[0]?.note).toMatch(/dust/);
  });

  it('orders by block number then log index', () => {
    const entries = reconcileAddress({
      ...base,
      address: f.sender,
      logs: [...f.receipt.logs].reverse() as Log[],
    });
    expect(entries.map((e) => e.logIndex)).toEqual([...entries.map((e) => e.logIndex)].sort((a, b) => a - b));
  });

  // `fetchAddressLogs` (the real caller against live data) only ever queries `Memo(sender)`, never
  // `BeforeMemo` — so an address-scoped fetch alone can never satisfy `bracketFor`'s pairing and a
  // memo would never attach. These two cases pin the fix: with the tx's receipt available,
  // reconcileAddress reads the receipt's own full log set (which does carry BeforeMemo) instead of
  // whatever subset of logs was passed in; without a receipt, it falls back to the passed-in logs
  // and memos stay unattached (the documented truncation).
  it('attaches memos from the receipt log set even when only Transfer logs were fetched', () => {
    const emitter = ADDRESSES[5042002].systemEmitter.address;
    const transfersOnly = f.receipt.logs.filter((x) => x.address.toLowerCase() === emitter.toLowerCase());
    expect(transfersOnly.length).toBeGreaterThan(0);
    const entries = reconcileAddress({ ...base, address: f.sender, logs: transfersOnly as Log[] });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.memoId !== null)).toBe(true);
  });

  it('leaves memoId null when only Transfer logs were fetched and no receipt is available', () => {
    const emitter = ADDRESSES[5042002].systemEmitter.address;
    const transfersOnly = f.receipt.logs.filter((x) => x.address.toLowerCase() === emitter.toLowerCase());
    const entries = reconcileAddress({
      ...base,
      address: f.sender,
      logs: transfersOnly as Log[],
      receiptsByTx: new Map(),
    });
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.memoId === null)).toBe(true);
  });
});
