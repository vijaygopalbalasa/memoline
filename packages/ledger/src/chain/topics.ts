import { toEventSelector } from 'viem';

export const TOPICS = {
  transfer: toEventSelector('Transfer(address,address,uint256)'),
  memo: toEventSelector('Memo(address,address,bytes32,bytes32,bytes,uint256)'),
  beforeMemo: toEventSelector('BeforeMemo(uint256)'),
} as const;
