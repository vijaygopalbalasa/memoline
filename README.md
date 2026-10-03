# Memoline

The money back office for businesses on [Arc](https://docs.arc.io). Pay many people in USDC or EURC from a
spreadsheet, with an invoice reference on every payment. Keep books where every payment is counted once and
every line ties back to Arc.

Memoline never holds keys or funds. Your own wallet signs every payment, and money goes straight from your
wallet to the people you pay.

- **Live on Arc mainnet:** https://memoline-one.vercel.app
- **Testnet:** https://memoline-testnet.vercel.app
- **Demo video (2 min 35 s):** https://youtu.be/FqULZKNOnl8
- **A real mainnet payout made with Memoline:** 3 payments, 3.00 USDC, one transaction, each payment with
  its own reference. See the
  [proof page](https://memoline-one.vercel.app/tx/0x6459e57bbf838394c839c6590b73fb905b5892dfd2292353a696b2282f563eaf)
  or the
  [explorer](https://explorer.arc.io/tx/0x6459e57bbf838394c839c6590b73fb905b5892dfd2292353a696b2282f563eaf).

## How Memoline uses Arc

- **Memo.** Each payment is sent as `Memo.memo(token, transfer(recipient, amount), memoId, reference)`. The
  transfer and its reference happen in one call, and Arc emits a `Memo` event that ties them together, so a
  payment can always be matched to its invoice.
- **Multicall3From.** A whole list of payments goes out as one `aggregate3` transaction from the payer's own
  wallet. Arc's CallFrom precompile keeps the payer as the sender of every transfer, which an ordinary
  multicall cannot do, and the transaction pays every payment or none of them.
- **USDC as gas.** Network fees are paid in USDC, and the books keep them apart from payments.
- **One balance, two logs.** Arc logs every native USDC movement from a system address, and a transfer
  through the USDC contract logs it a second time. Memoline counts each movement once.

## What is in this repository

Only the parts that show how Memoline talks to Arc:

| File | What it shows |
|---|---|
| [`arc/contracts.ts`](./arc/contracts.ts) | The Arc contracts Memoline calls on mainnet and testnet, and the shape of each call. |
| [`arc/pay-with-memos.ts`](./arc/pay-with-memos.ts) | How a list of payments becomes one Multicall3From transaction with a reference on every payment. |
| [`arc/read-memos.ts`](./arc/read-memos.ts) | How such a transaction is read back into payments and their references. |
| [`mcp/`](./mcp) | The Memoline MCP client: lets an AI agent read Arc transactions and addresses as ledger lines through Memoline's public API. MIT licensed. |

The examples use [viem](https://viem.sh) 2. The application, its payout and reconciliation engine, and its
test suite are private.

## Status (3 October 2026)

- **Live on Arc mainnet:** batch payouts in USDC and EURC from a spreadsheet, a check of the file before
  signing, reconciling any Arc address into ledger lines, and a proof page for any transaction.
- **Running on Arc testnet, coming to mainnet next:** payment links and invoices, monthly statements and Xero
  and QuickBooks files, a chart of accounts with booking rules, closing a month against Arc, the Overview, team
  roles, approvals and a second person to confirm changes, payee checks and Circle's blocklist before signing,
  screening against the US Treasury's sanctions list (OFAC), private payroll (one payee per transaction),
  auditor links (a read-only view of chosen accounts and dates for an auditor), two-step sign-in,
  notifications, and a keyed API that agents can use to prepare payouts.
- **Memoline's fee, where a site charges it:** 0.25 USDC for each payment in a payout, paid in USDC in the same
  transaction as the payments; a workspace's first 10 payments are free, once. The pricing page and the new
  payout form say whether a site charges it.
- **The MCP client** in [`mcp/`](./mcp), MIT licensed: not on npm yet, so build it from that folder.
- More than 2,300 automated tests.

## Licence

The [`mcp/`](./mcp) folder is the Memoline MCP client (`@memoline/mcp`), which lets an AI agent read Arc as
ledger lines through Memoline's public API. It is under its own MIT licence, in [`mcp/LICENSE`](./mcp/LICENSE).
Everything else in this repository stays all rights reserved. See [LICENSE](./LICENSE).

## Author

Built by Vijaygopal Balasa ([github.com/vijaygopalbalasa](https://github.com/vijaygopalbalasa)).
