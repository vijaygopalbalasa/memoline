import { type Address, decodeErrorResult, type Hex } from 'viem';

export type ErrorCode =
  | 'BLOCKLISTED'
  | 'ZERO_ADDRESS'
  | 'INSUFFICIENT_BALANCE'
  | 'RECIPIENT_IS_CONTRACT'
  | 'SENDER_NOT_EOA'
  | 'SENDER_7702_UNSUPPORTED'
  | 'GAS_CAP_EXCEEDED'
  | 'FEE_BELOW_FLOOR'
  | 'TX_REVERTED'
  | 'TX_DROPPED'
  | 'RPC_RATE_LIMITED'
  | 'RPC_HISTORY_UNAVAILABLE'
  | 'RPC_RANGE_TOO_LARGE'
  | 'RPC_FORBIDDEN'
  | 'CSV_MALFORMED'
  | 'BAD_CHECKSUM'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'REFERENCE_INVALID'
  | 'MEMO_TOO_LARGE'
  | 'WRONG_NETWORK'
  | 'UNKNOWN';

export type LedgerError = { code: ErrorCode; message: string; nextStep: string; detail?: unknown };

/** One plain sentence and one next step per code. Keep these human. */
const CATALOG: Record<ErrorCode, { message: string; nextStep: string }> = {
  BLOCKLISTED: {
    message: 'This address is blocklisted by the USDC issuer, so transfers to or from it revert.',
    nextStep: 'Remove the row or use a different recipient address.',
  },
  ZERO_ADDRESS: {
    message: 'The recipient is the zero address (0x000…000), which cannot receive funds.',
    nextStep: 'Fix the recipient address in your CSV.',
  },
  INSUFFICIENT_BALANCE: {
    message: 'The sender wallet does not hold enough of this token for this transfer.',
    nextStep: 'Top up the sender wallet or reduce the amounts, then re-run pre-flight.',
  },
  RECIPIENT_IS_CONTRACT: {
    message: 'The recipient is a smart contract, not a wallet.',
    nextStep: 'Confirm the contract can receive tokens before paying it.',
  },
  SENDER_NOT_EOA: {
    message:
      'The connected wallet is a smart-contract account. Arc memos can only be sent from an externally owned account (EOA).',
    nextStep: 'Connect a standard wallet (MetaMask, Rabby, Ledger) or use the plain-transfer path.',
  },
  SENDER_7702_UNSUPPORTED: {
    message: 'This wallet has an EIP-7702 delegation active, which has not been verified with Arc memos yet.',
    nextStep: 'Remove the delegation or connect another wallet.',
  },
  GAS_CAP_EXCEEDED: {
    message: 'This batch needs more gas than Arc allows in one transaction.',
    nextStep: 'Reduce rows per chunk; the app will split the batch.',
  },
  FEE_BELOW_FLOOR: {
    message: 'The gas price is below Arc’s 20 Gwei minimum; the network would drop the transaction silently.',
    nextStep: 'Let the app set the fee (it clamps to the floor).',
  },
  TX_REVERTED: {
    message: 'The transaction reverted on-chain; nothing was paid.',
    nextStep: 'Re-run pre-flight to find the failing row, then retry.',
  },
  TX_DROPPED: {
    message: 'The transaction was not included and no receipt exists.',
    nextStep: 'The app checked the memo log and nonce; it is safe to re-send this chunk.',
  },
  RPC_RATE_LIMITED: {
    message: 'The Arc RPC is rate-limiting requests.',
    nextStep: 'Wait a moment and retry; configure a provider RPC key for higher limits.',
  },
  RPC_HISTORY_UNAVAILABLE: {
    message: 'This RPC has pruned the requested block range.',
    nextStep: 'Use an archive RPC (Alchemy/QuickNode) or a narrower date range.',
  },
  RPC_RANGE_TOO_LARGE: {
    message: 'The RPC rejected the log query as too large.',
    nextStep: 'The app will retry with smaller block pages.',
  },
  RPC_FORBIDDEN: {
    message: 'The RPC refused the request (Cloudflare).',
    nextStep: 'Set RPC_USER_AGENT and/or use a provider endpoint.',
  },
  CSV_MALFORMED: {
    message: 'The CSV row is malformed.',
    nextStep: 'Use the columns recipient,amount,reference with one row per payment.',
  },
  BAD_CHECKSUM: {
    message: 'The address checksum is invalid — a typo would send funds to the wrong place.',
    nextStep: 'Copy the address again from the recipient in EIP-55 (mixed-case) form.',
  },
  AMOUNT_OUT_OF_RANGE: {
    message: 'The amount is not a positive decimal with at most 6 decimal places.',
    nextStep: 'Write amounts like 125.50 with no commas, signs or exponents.',
  },
  REFERENCE_INVALID: {
    message: 'The reference contains characters that are not allowed on-chain.',
    nextStep: 'Use letters, digits and . _ : - (max 64 chars). References are public.',
  },
  MEMO_TOO_LARGE: { message: 'The memo data exceeds 256 bytes.', nextStep: 'Shorten the reference.' },
  WRONG_NETWORK: {
    message: 'Your wallet is on a different network than this run.',
    nextStep: 'Switch your wallet to Arc (or Arc Testnet) and try again.',
  },
  UNKNOWN: {
    message: 'Something unexpected happened.',
    nextStep: 'Retry; if it persists, report the details shown.',
  },
};

export function ledgerError(code: ErrorCode, detail?: unknown): LedgerError {
  const c = CATALOG[code];
  return detail === undefined ? { code, ...c } : { code, ...c, detail };
}

export function isLedgerError(x: unknown): x is LedgerError {
  return (
    typeof x === 'object' &&
    x !== null &&
    'code' in x &&
    'message' in x &&
    'nextStep' in x &&
    (x as LedgerError).code in CATALOG
  );
}

const ZERO = '0x0000000000000000000000000000000000000000';
const errorAbi = [
  { type: 'error', name: 'Error', inputs: [{ name: 'reason', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const;

/** Map revert data from eth_call / receipts to a LedgerError. Never throws. */
export function mapRevert(
  revertData: Hex | undefined,
  ctx: { recipient?: Address; blocklistedHint?: boolean },
): LedgerError {
  if (ctx.recipient && ctx.recipient.toLowerCase() === ZERO) return ledgerError('ZERO_ADDRESS');
  if (!revertData || revertData === '0x')
    return ledgerError(ctx.blocklistedHint ? 'BLOCKLISTED' : 'TX_REVERTED', revertData);
  try {
    const decoded = decodeErrorResult({ abi: errorAbi, data: revertData });
    if (decoded.errorName === 'Error') {
      const reason = String(decoded.args[0]).toLowerCase();
      if (/blocklist|denylist|blacklist|denied/.test(reason)) return ledgerError('BLOCKLISTED', reason);
      if (/exceeds balance|insufficient|exceeds allowance/.test(reason))
        return ledgerError('INSUFFICIENT_BALANCE', reason);
      return ledgerError('TX_REVERTED', reason);
    }
    return ledgerError('TX_REVERTED', `Panic(${decoded.args[0]})`);
  } catch {
    return ledgerError('TX_REVERTED', revertData);
  }
}

/** Collects shortMessage/message/details from an error and recursively from `.cause` (bounded depth: viem wraps errors several levels deep, e.g. TransactionExecutionError -> RpcRequestError -> HttpRequestError). */
function errText(e: unknown, depth = 0): string {
  if (typeof e === 'string') return e;
  if (!e || typeof e !== 'object' || depth >= 5) return depth === 0 ? String(e) : '';
  const o = e as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown };
  const parts = [o.shortMessage, o.message, o.details].filter((x): x is string => typeof x === 'string');
  if (o.cause !== undefined && o.cause !== null) parts.push(errText(o.cause, depth + 1));
  return parts.filter((s) => s.length > 0).join(' | ');
}
function errCode(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; status?: unknown; cause?: unknown };
    if (typeof o.code === 'number') return o.code;
    if (typeof o.status === 'number') return o.status;
    if (o.cause) return errCode(o.cause);
  }
  return undefined;
}

/** Map transport / JSON-RPC errors. `chunkRows` disambiguates EIP-7825 cap (-32003) from a real out-of-gas on a tiny chunk. */
export function mapRpcError(e: unknown, ctx: { chunkRows?: number } = {}): LedgerError {
  const text = errText(e);
  const code = errCode(e);
  if (code === 429 || /status:\s*429|too many requests/i.test(text))
    return ledgerError('RPC_RATE_LIMITED', text);
  if (code === 4444 || /pruned history/i.test(text)) return ledgerError('RPC_HISTORY_UNAVAILABLE', text);
  if (code === -32602 && /range/i.test(text)) return ledgerError('RPC_RANGE_TOO_LARGE', text);
  if (code === 403 || /status:\s*403|error code:\s*1010/i.test(text))
    return ledgerError('RPC_FORBIDDEN', text);
  // GAS_CAP_EXCEEDED only when the numeric RPC code is -32003 (Arc returns -32003 for both a real
  // out-of-gas and the EIP-7825 per-tx cap); chunkRows disambiguates. A text-only "out of gas" mention
  // without that numeric code (e.g. a genuine revert) is always TX_REVERTED, never the cap.
  if (code === -32003) {
    return ledgerError((ctx.chunkRows ?? 0) >= 10 ? 'GAS_CAP_EXCEEDED' : 'TX_REVERTED', text);
  }
  if (/out of gas|gas limit/i.test(text)) return ledgerError('TX_REVERTED', text);
  return ledgerError('UNKNOWN', text);
}
