import { describe, expect, it } from 'vitest';
import {
  csvEscape,
  csvText,
  entriesToCsv,
  type LedgerEntry,
  type RunReport,
  runToCsv,
  runToJson,
} from '../src/index.js';

const report: RunReport = {
  runId: 'RUN1',
  chainId: 5042002,
  sender: '0x427C62eDCae20DDc8c5e875De39D4E4845491458',
  token: 'USDC',
  csvSha256: 'abc',
  generatedAt: '2026-09-19T00:00:00Z',
  rows: [
    {
      rowIndex: 0,
      reference: 'INV-1',
      recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      amount6: 125_500_000n,
      status: 'RECONCILED',
      txHash: '0xaa',
      logIndex: 3,
      memoId: '0x01',
      memoIndex: 7n,
      blockNumber: 100n,
      blockTime: 1_789_000_000,
      feeRowNative18: 4n,
      feeChunkNative18: 10n,
      explorerUrl: 'https://explorer.testnet.arc.io/tx/0xaa',
    },
    {
      rowIndex: 1,
      reference: 'INV-2',
      recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      amount6: 40_000_000n,
      status: 'EXCLUDED',
      memoId: '0x02',
      exceptionReason: 'BLOCKLISTED: This address is blocklisted',
    },
    {
      rowIndex: 2,
      reference: 'a,b "q"',
      recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      amount6: 1n,
      status: 'RECONCILED',
      txHash: '0xaa',
      logIndex: 5,
      memoId: '0x03',
      memoIndex: 8n,
      blockNumber: 100n,
      blockTime: 1_789_000_000,
      feeRowNative18: 3n,
      feeChunkNative18: 10n,
    },
  ],
};

// Fee cells are exact decimals (formatNative18Exact): a 7-unit dust-only fee total is the plain
// number 0.000000000000000007, which a spreadsheet can sum — never an annotated "(+7 dust)" string.
const BLOCK_TIME_PREFIX = new Date(1_789_000_000 * 1000).toISOString().slice(0, 11);

describe('runToCsv', () => {
  it('has the SPEC §6.8 header, one line per row, and a footer that ties out', () => {
    const csv = runToCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'run_id,row,reference,recipient,token,amount,amount_base6,amount_native18,status,tx_hash,log_index,memo_id,memo_index,block_number,block_time_utc,fee_usdc_row,fee_native18_row,fee_usdc_chunk,fee_native18_chunk,exception_reason,explorer_url',
    );
    expect(lines[1]).toContain(
      `RUN1,0,INV-1,0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,USDC,125.50,125500000,125500000000000000000,RECONCILED,0xaa,3,0x01,7,100,${BLOCK_TIME_PREFIX}`,
    );
    expect(lines[3]).toContain('"a,b ""q"""');
    expect(csv).toContain('rows_paid,2');
    expect(csv).toContain('rows_excluded,1');
    expect(csv).toContain('rows_exception,0');
    expect(csv).toContain('total_paid,125.500001');
    // Fee cells: exact decimal, then the integer native units, for both the row and its chunk.
    const first = lines[1] ?? '';
    const cells = first.split(',');
    const h = (lines[0] ?? '').split(',');
    expect(cells[h.indexOf('fee_usdc_row')]).toMatch(/^\d+\.\d+$/);
    expect(cells[h.indexOf('fee_native18_row')]).toMatch(/^\d+$/);
    expect(cells[h.indexOf('fee_usdc_chunk')]).toMatch(/^\d+\.\d+$/);
    expect(cells[h.indexOf('fee_native18_chunk')]).toMatch(/^\d+$/);
    expect(csv).toContain('total_fees_usdc,0.000000000000000007');
    expect(csv).toContain('total_fees_native18,7');
    expect(csv).toContain('csv_sha256,abc');
    expect(csv).toContain('chain_id,5042002');
  });
  it('never uses floats: amounts are exact strings for large values', () => {
    const firstRow = report.rows[0];
    if (!firstRow) throw new Error('expected report.rows[0] to exist');
    const big = { ...report, rows: [{ ...firstRow, amount6: 123_456_789_012_345_678n }] };
    expect(runToCsv(big)).toContain('123456789012.345678,123456789012345678,123456789012345678000000000000');
  });
  it('never guards a negative numeric amount — only free-text cells get the formula guard', () => {
    const firstRow = report.rows[0];
    if (!firstRow) throw new Error('expected report.rows[0] to exist');
    const negative = { ...report, rows: [{ ...firstRow, amount6: -5_000_000n }] };
    const line = runToCsv(negative).split('\n')[1] ?? '';
    // amount, amount_base6, amount_native18 all render as real negative numbers, unguarded, so
    // SUM() in Excel/Sheets still ties out.
    expect(line).toContain(',-5.00,-5000000,-5000000000000000000,');
    expect(line).not.toContain("'-5.00");
    expect(line).not.toContain("'-5000000");
  });
  it('guards a formula-injection reference without touching the numeric cells on the same row', () => {
    const firstRow = report.rows[0];
    if (!firstRow) throw new Error('expected report.rows[0] to exist');
    const injected = { ...report, rows: [{ ...firstRow, reference: '=cmd|/bin/calc' }] };
    const line = runToCsv(injected).split('\n')[1] ?? '';
    expect(line).toContain("'=cmd|/bin/calc");
    expect(line).toContain(',125.50,125500000,125500000000000000000,'); // amounts stay unguarded
  });
  it('leaves amount_native18 empty for a non-USDC (EURC) report', () => {
    const firstRow = report.rows[0];
    if (!firstRow) throw new Error('expected report.rows[0] to exist');
    const eurcReport: RunReport = { ...report, token: 'EURC', rows: [firstRow] };
    const line = runToCsv(eurcReport).split('\n')[1] ?? '';
    // token,amount,amount_base6,amount_native18,status — amount_native18 is the empty field.
    expect(line).toContain('EURC,125.50,125500000,,RECONCILED');
  });
});

describe('csvEscape', () => {
  it('quotes commas, quotes, newlines; leaves plain values', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('x\ny')).toBe('"x\ny"');
  });
  it('never applies the formula-injection guard — that is csvText’s job, not a plain cell’s', () => {
    expect(csvEscape('=SUM(A1)')).toBe('=SUM(A1)');
    expect(csvEscape('-5000000')).toBe('-5000000');
  });
});

describe('csvText', () => {
  it('guards leading formula/command characters for free-text cells only', () => {
    expect(csvText('plain')).toBe('plain');
    expect(csvText('=SUM(A1)')).toBe("'=SUM(A1)"); // formula injection guard
    expect(csvText('+1')).toBe("'+1");
    expect(csvText('-1')).toBe("'-1");
    expect(csvText('@cmd')).toBe("'@cmd");
    expect(csvText(null)).toBe('');
    expect(csvText(undefined)).toBe('');
  });
});

describe('runToJson / entriesToCsv', () => {
  it('serialises bigints as strings and round-trips', () => {
    const j = JSON.parse(runToJson(report));
    expect(j.rows[0].amount6).toBe('125500000');
    expect(j.footer.total_paid_base6).toBe('125500001');
  });
  it('entriesToCsv writes one line per entry with direction and memo', () => {
    const e: LedgerEntry = {
      direction: 'in',
      token: 'USDC',
      amount6: 5n,
      amountNative18: 5_000_000_000_000n,
      counterparty: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      txHash: '0xbb',
      logIndex: 1,
      memoId: null,
      memoIndex: null,
      reference: null,
      sourceType: 'import',
      sourceId: 'IMP',
      blockNumber: 5n,
      blockTime: 0,
      feeNative18: 0n,
      note: null,
    };
    const csv = entriesToCsv([e], { chainId: 5042002, generatedAt: 'now' });
    expect(csv.split('\n')[0]).toBe(
      'direction,token,amount,amount_base6,amount_native18,counterparty,reference,tx_hash,log_index,memo_id,memo_index,source_type,source_id,block_number,block_time_utc,fee_usdc,fee_native18,note,explorer_url',
    );
    expect(csv.split('\n')[1]).toContain('in,USDC,0.000005,5,5000000000000,0x3C44');
    expect(csv.split('\n')[1]).toContain(',,0xbb,'); // empty reference cell between counterparty and tx
    const withRef = entriesToCsv([{ ...e, reference: 'INV-7', feeNative18: 5n }], {
      chainId: 5042002,
      generatedAt: 'now',
    });
    const cells = (withRef.split('\n')[1] ?? '').split(',');
    const h = (withRef.split('\n')[0] ?? '').split(',');
    expect(cells[h.indexOf('reference')]).toBe('INV-7');
    expect(cells[h.indexOf('fee_usdc')]).toBe('0.000000000000000005');
    expect(cells[h.indexOf('fee_native18')]).toBe('5');
  });
  it('escapes a comma/quote in the entries footer instead of writing a raw template string', () => {
    const e: LedgerEntry = {
      direction: 'in',
      token: 'USDC',
      amount6: 5n,
      amountNative18: 5_000_000_000_000n,
      counterparty: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      txHash: '0xbb',
      logIndex: 1,
      memoId: null,
      memoIndex: null,
      reference: null,
      sourceType: 'import',
      sourceId: 'IMP',
      blockNumber: 5n,
      blockTime: 0,
      feeNative18: 0n,
      note: null,
    };
    const csv = entriesToCsv([e], { chainId: 5042002, generatedAt: 'now, "really"' });
    expect(csv).toContain('generated_at,"now, ""really"""');
  });
});
