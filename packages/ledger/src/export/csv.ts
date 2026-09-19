import type { Address, Hex } from 'viem';
import type { ChainId, Token } from '../chain/addresses.js';
import { explorerTxUrl } from '../chain/chains.js';
import { format6, formatNative18, toNative18 } from '../money/amount.js';
import type { LedgerEntry } from '../reconcile/types.js';

export type RunReportRow = {
  rowIndex: number;
  reference: string;
  recipient: Address;
  amount6: bigint;
  status: 'RECONCILED' | 'EXCLUDED' | 'EXCEPTION' | 'PENDING' | 'SENT';
  txHash?: Hex;
  logIndex?: number;
  memoId: Hex;
  memoIndex?: bigint;
  blockNumber?: bigint;
  blockTime?: number;
  feeRowNative18?: bigint;
  feeChunkNative18?: bigint;
  exceptionReason?: string;
  explorerUrl?: string;
};
export type RunReport = {
  runId: string;
  chainId: ChainId;
  sender: Address;
  token: Token;
  csvSha256: string;
  generatedAt: string;
  rows: RunReportRow[];
};

export const RUN_CSV_HEADER =
  'run_id,row,reference,recipient,token,amount,amount_base6,amount_native18,status,tx_hash,log_index,memo_id,memo_index,block_number,block_time_utc,fee_usdc_row,fee_usdc_chunk,exception_reason,explorer_url';
export const ENTRIES_CSV_HEADER =
  'direction,token,amount,amount_base6,amount_native18,counterparty,tx_hash,log_index,memo_id,memo_index,source_type,source_id,block_number,block_time_utc,fee_usdc,note,explorer_url';

type CsvCell = string | number | bigint | null | undefined;

/**
 * RFC 4180 quoting only: wraps a cell in quotes and doubles internal quotes when it contains a
 * comma, quote, or newline. No formula-injection guard here — this is the function applied
 * uniformly to every cell (via `toCsvLine`), including computed numeric/enum/hash cells, where a
 * leading '-' is a real negative amount and must never be turned into a guarded text cell.
 */
export function csvEscape(v: CsvCell): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Spreadsheet formula-injection guard for free-text fields only (reference, exception reason,
 * note — never a computed numeric/enum/hash cell): prefixes a leading apostrophe when the raw
 * value would otherwise be interpreted as a formula or command by Excel/Sheets/LibreOffice
 * (leading `=`, `+`, `-`, `@`, tab, or CR). Apply this to a free-text value before placing it in
 * the cell array passed to `toCsvLine` — `toCsvLine` still applies the one, uniform RFC 4180
 * quoting pass on top via `csvEscape`, so callers must not quote here themselves.
 */
export function csvText(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/**
 * Joins cell values into one RFC 4180 CSV line, applying `csvEscape` to every cell exactly once.
 * Free-text cells (reference, exception reason, note) must be pre-processed with `csvText` before
 * being included here so the formula-injection guard lands only on those columns.
 */
export function toCsvLine(cells: CsvCell[]): string {
  return cells.map((c) => csvEscape(c)).join(',');
}

const iso = (t?: number) => (t === undefined || t === 0 ? '' : new Date(t * 1000).toISOString());

export function runFooter(r: RunReport) {
  const paid = r.rows.filter((x) => x.status === 'RECONCILED');
  const totalPaid = paid.reduce((s, x) => s + x.amount6, 0n);
  const totalFees = paid.reduce((s, x) => s + (x.feeRowNative18 ?? 0n), 0n);
  return {
    rows_paid: paid.length,
    rows_excluded: r.rows.filter((x) => x.status === 'EXCLUDED').length,
    rows_exception: r.rows.filter((x) => x.status === 'EXCEPTION').length,
    rows_pending: r.rows.filter((x) => x.status === 'PENDING' || x.status === 'SENT').length,
    total_paid: format6(totalPaid),
    total_paid_base6: totalPaid,
    total_fees_usdc: formatNative18(totalFees),
    total_fees_native18: totalFees,
    sender: r.sender,
    token: r.token,
    chain_id: r.chainId,
    csv_sha256: r.csvSha256,
    generated_at: r.generatedAt,
  };
}

export function runToCsv(r: RunReport): string {
  const lines = [RUN_CSV_HEADER];
  for (const x of r.rows) {
    lines.push(
      toCsvLine([
        r.runId,
        x.rowIndex,
        csvText(x.reference),
        x.recipient,
        r.token,
        format6(x.amount6),
        x.amount6,
        r.token === 'USDC' ? toNative18(x.amount6) : '',
        x.status,
        x.txHash ?? '',
        x.logIndex ?? '',
        x.memoId,
        x.memoIndex ?? '',
        x.blockNumber ?? '',
        iso(x.blockTime),
        x.feeRowNative18 === undefined ? '' : formatNative18(x.feeRowNative18),
        x.feeChunkNative18 === undefined ? '' : formatNative18(x.feeChunkNative18),
        csvText(x.exceptionReason),
        x.explorerUrl ?? (x.txHash ? explorerTxUrl(r.chainId, x.txHash) : ''),
      ]),
    );
  }
  lines.push('');
  for (const [k, v] of Object.entries(runFooter(r))) lines.push(toCsvLine([k, v]));
  return lines.join('\n');
}

export function entriesToCsv(
  entries: LedgerEntry[],
  meta: { chainId: ChainId; generatedAt: string },
): string {
  const lines = [ENTRIES_CSV_HEADER];
  for (const e of entries) {
    lines.push(
      toCsvLine([
        e.direction,
        e.token,
        format6(e.amount6),
        e.amount6,
        e.amountNative18 ?? '',
        e.counterparty,
        e.txHash,
        e.logIndex,
        e.memoId ?? '',
        e.memoIndex ?? '',
        e.sourceType,
        e.sourceId ?? '',
        e.blockNumber,
        iso(e.blockTime),
        formatNative18(e.feeNative18),
        csvText(e.note),
        explorerTxUrl(meta.chainId, e.txHash),
      ]),
    );
  }
  const out = entries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount6, 0n);
  const inn = entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount6, 0n);
  const fees = entries.reduce((s, e) => s + e.feeNative18, 0n);
  lines.push('');
  lines.push(toCsvLine(['entries', entries.length]));
  lines.push(toCsvLine(['total_out', format6(out)]));
  lines.push(toCsvLine(['total_in', format6(inn)]));
  lines.push(toCsvLine(['total_fees_usdc', formatNative18(fees)]));
  lines.push(toCsvLine(['chain_id', meta.chainId]));
  lines.push(toCsvLine(['generated_at', meta.generatedAt]));
  return lines.join('\n');
}
