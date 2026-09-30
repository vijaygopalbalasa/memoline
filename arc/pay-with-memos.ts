/**
 * How a list of payments becomes one Arc transaction with a reference on every payment.
 *
 * Each payment is Memo.memo(token, transfer(to, amount), memoId, reference). The list goes out as one
 * Multicall3From.aggregate3 transaction signed by the payer's own wallet, so every transfer comes from
 * the payer, and with allowFailure false the transaction pays every payment or none of them.
 *
 * Amounts are bigint in the token's 6 decimals: 1.50 USDC is 1_500_000n.
 * References are public and permanent on-chain: use opaque ids such as invoice numbers, never names.
 *
 * This shows the shape of the call only. The app wraps it in what a real payout needs: checking the
 * file, simulating every payment before signing, splitting long lists, and never paying twice.
 */
import { type Address, encodeFunctionData, erc20Abi, type Hex, keccak256, stringToHex } from 'viem';
import { ARC, memoAbi, multicall3FromAbi } from './contracts.js';

export type Payment = { to: Address; amount6: bigint; reference: string };

/** One payment as a call to the Memo contract. memoId can be any 32 bytes that identify the payment. */
export function paymentCall(memo: Address, token: Address, p: Payment) {
  const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p.to, p.amount6] });
  return {
    target: memo,
    allowFailure: false,
    callData: encodeFunctionData({
      abi: memoAbi,
      functionName: 'memo',
      args: [token, transfer, keccak256(stringToHex(p.reference)), stringToHex(p.reference)],
    }),
  };
}

/** The data of one transaction: send it to ARC[network].multicall3From from the paying wallet. */
export function batchCalldata(network: 'mainnet' | 'testnet', token: 'usdc' | 'eurc', payments: Payment[]): Hex {
  const arc = ARC[network];
  return encodeFunctionData({
    abi: multicall3FromAbi,
    functionName: 'aggregate3',
    args: [payments.map((p) => paymentCall(arc.memo, arc[token], p))],
  });
}

// Example, with a viem wallet client connected to Arc testnet:
//
//   const data = batchCalldata('testnet', 'usdc', [
//     { to: '0x1111111111111111111111111111111111111111', amount6: 1_500_000n, reference: 'INV-1001' },
//     { to: '0x2222222222222222222222222222222222222222', amount6: 250_000n, reference: 'INV-1002' },
//   ]);
//   const hash = await wallet.sendTransaction({ to: ARC.testnet.multicall3From, data });
