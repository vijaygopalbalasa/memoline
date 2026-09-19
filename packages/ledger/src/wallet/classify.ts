import type { Hex } from 'viem';

export type SenderKind = 'eoa' | 'eoa-7702' | 'contract';

/**
 * Memo/Multicall3From require the original sender to be tx.origin (CallFrom rule), so only EOAs can pay.
 * EIP-7702 designators (0xef0100 + 20-byte address) are delegated EOAs: still tx.origin when they sign directly,
 * but unverified with Memo until Spike 0 test 7 passes — callers gate them behind ALLOW_7702_SENDERS.
 */
export function classifySender(code: Hex | undefined): SenderKind {
  if (!code || code === '0x') return 'eoa';
  const c = code.toLowerCase();
  if (c.startsWith('0xef0100') && c.length === 2 + 46) return 'eoa-7702';
  return 'contract';
}
