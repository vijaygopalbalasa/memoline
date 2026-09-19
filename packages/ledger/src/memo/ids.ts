import { type Hex, keccak256, stringToHex } from 'viem';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 128 random bits as 26 Crockford-base32 chars. Not sequential, not guessable. */
export function newRunId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

export function payoutMemoId(runId: string, rowIndex: number): Hex {
  return keccak256(stringToHex(`po:${runId}:${rowIndex}`));
}

export function linkMemoId(linkId: string): Hex {
  return keccak256(stringToHex(`pl:${linkId}`));
}
