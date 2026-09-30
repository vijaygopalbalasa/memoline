/**
 * How a Memoline payout transaction is read back into payments and their references.
 *
 * The payer signed one Multicall3From.aggregate3 call holding one Memo.memo call per payment. Each Memo
 * call carries a token transfer and a reference; for each one Arc emitted a Memo event with the hash of
 * the transfer it ran. A payment counts as made when its transfer's hash and memo id appear in a Memo
 * event of the successful receipt.
 */
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  erc20Abi,
  type Hash,
  hexToString,
  http,
  isAddressEqual,
  keccak256,
} from 'viem';
import { ARC, memoAbi, multicall3FromAbi } from './contracts.js';

/** `rpc` defaults to Arc's public endpoint; older receipts may need a provider that keeps history. */
export async function readPayments(network: 'mainnet' | 'testnet', hash: Hash, rpc: string = ARC[network].rpc) {
  const arc = ARC[network];
  const client = createPublicClient({
    transport: http(rpc, { fetchOptions: { headers: { 'User-Agent': 'memoline-example/1.0' } } }),
  });
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash }),
    client.getTransactionReceipt({ hash }),
  ]);
  if (receipt.status !== 'success' || !tx.to || !isAddressEqual(tx.to, arc.multicall3From)) return [];

  // What Arc recorded: one Memo event per payment that ran.
  const events = receipt.logs.flatMap((log) => {
    if (!isAddressEqual(log.address, arc.memo)) return [];
    try {
      const e = decodeEventLog({ abi: memoAbi, data: log.data, topics: log.topics });
      return e.eventName === 'Memo' ? [e.args] : [];
    } catch {
      return [];
    }
  });

  // What the payer signed: the Memo calls inside the aggregate3 call.
  const { args } = decodeFunctionData({ abi: multicall3FromAbi, data: tx.input });
  return args[0]
    .filter((call) => isAddressEqual(call.target, arc.memo))
    .map((call) => {
      const [token, data, memoId, memoData] = decodeFunctionData({ abi: memoAbi, data: call.callData }).args;
      const transfer = decodeFunctionData({ abi: erc20Abi, data });
      const [to, amount6] = transfer.functionName === 'transfer' ? transfer.args : [undefined, undefined];
      const recorded = events.some((e) => e.memoId === memoId && e.callDataHash === keccak256(data));
      return { from: tx.from, token, to, amount6, reference: hexToString(memoData), recorded };
    });
}

// Example: the first Memoline payout on Arc mainnet (3 payments, 3.00 USDC).
//
//   const payments = await readPayments(
//     'mainnet',
//     '0x6459e57bbf838394c839c6590b73fb905b5892dfd2292353a696b2282f563eaf',
//   );
