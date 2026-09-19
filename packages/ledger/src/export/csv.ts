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

/** RFC 4180 quoting plus a spreadsheet formula-injection guard. */
export function csvEscape(v: string | number | bigint | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
      [
        r.runId,
        x.rowIndex,
        csvEscape(x.reference),
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
        csvEscape(x.exceptionReason),
        x.explorerUrl ?? (x.txHash ? explorerTxUrl(r.chainId, x.txHash) : ''),
      ]
        .map((c) => (typeof c === 'string' && c.startsWith('"') ? c : csvEscape(c)))
        .join(','),
    );
  }
  lines.push('');
  for (const [k, v] of Object.entries(runFooter(r))) lines.push(`${k},${csvEscape(String(v))}`);
  return lines.join('\n');
}

export function entriesToCsv(
  entries: LedgerEntry[],
  meta: { chainId: ChainId; generatedAt: string },
): string {
  const lines = [ENTRIES_CSV_HEADER];
  for (const e of entries) {
    lines.push(
      [
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
        csvEscape(e.note),
        explorerTxUrl(meta.chainId, e.txHash),
      ]
        .map((c) => (typeof c === 'string' && c.startsWith('"') ? c : csvEscape(c)))
        .join(','),
    );
  }
  const out = entries.filter((e) => e.direction === 'out').reduce((s, e) => s + e.amount6, 0n);
  const inn = entries.filter((e) => e.direction === 'in').reduce((s, e) => s + e.amount6, 0n);
  const fees = entries.reduce((s, e) => s + e.feeNative18, 0n);
  lines.push(
    '',
    `entries,${entries.length}`,
    `total_out,${format6(out)}`,
    `total_in,${format6(inn)}`,
    `total_fees_usdc,${formatNative18(fees)}`,
    `chain_id,${meta.chainId}`,
    `generated_at,${meta.generatedAt}`,
  );
  return lines.join('\n');
}
