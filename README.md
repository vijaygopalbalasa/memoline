# Memoline

**Live app:** mainnet https://memoline-one.vercel.app · testnet https://memoline-testnet.vercel.app
**Demo video (2 min 35 s):** https://youtu.be/FqULZKNOnl8

Memoline is a non-custodial back office for stablecoin payouts on [Arc](https://docs.arc.io). You give it
a CSV of recipients, amounts and invoice references; your own wallet signs each batch of up to a hundred
payments; every payment carries its reference on-chain through Arc's Memo contract; and Memoline turns the
receipts back into ledger lines that tie out to the cent. It holds no keys and no funds, and touches no
fiat: it only moves and reconciles USDC and EURC that are already on Arc.

This repository is the **open core** of Memoline: the ledger engine the app is built on, its tests and
fixtures, and the acceptance scripts that run it against live Arc. The hosted application (the pages at the
links above, and the service layer behind them) is proprietary and is not in this repository.

## Try the app in two minutes, no wallet needed

1. **Check a payout file.** Open [`/check`](https://memoline-one.vercel.app/check) and press *Try the
   sample file*. The file is parsed with the payout's own rules, the paying wallet's balance is checked,
   and every payment is simulated on Arc from that address, one `eth_call` per transaction of up to 100
   payments: which payments would go through, which would be set aside and why, how many transactions
   you would sign and the most the gas could cost.
2. **Reconcile any address.** On the [home page](https://memoline-one.vercel.app/#reconcile), press *try
   it with a live example address* (or paste any Arc address). You get its USDC and EURC movements as
   ledger lines: direction, amount, counterparty, the reference decoded from the on-chain memo, and gas
   to the last unit, each movement counted once.
3. **Read a transaction as ledger lines.** Any transaction hash at `/tx/<hash>` is read back the same way.
   A real payout made through the app on Arc mainnet:
   [proof page](https://memoline-one.vercel.app/tx/0x6459e57bbf838394c839c6590b73fb905b5892dfd2292353a696b2282f563eaf)
   and [explorer](https://explorer.arc.io/tx/0x6459e57bbf838394c839c6590b73fb905b5892dfd2292353a696b2282f563eaf):
   3 payments, 3.00 USDC, one transaction, gas split across the lines to the last unit.

## What is in this repository

`packages/ledger` (`@memoline/ledger`, Apache-2.0) is a pure TypeScript library with no framework and no
database. It is what the app calls; anything that touches Arc money can use it the same way.

| Module | What it does |
|---|---|
| `chain/` | Verified Arc addresses (USDC, EURC, Memo, Multicall3From, the system emitter) with their sources and dates; chain definitions; a client with an explicit `User-Agent`, a history-first fallback for `eth_getLogs`, and a startup check that every contract has bytecode. |
| `money/` | `bigint` money end to end: 6-decimal token units, 18-decimal native units, exact parsing and formatting, pro-rata gas allocation to the base unit. Property-tested. |
| `memo/` | Memo ids and memo data: encode a reference for the Memo contract, decode one back, up to 256 bytes. |
| `batch/` | Build a payout batch: one `Memo.memo(token, transfer(recipient, amount), memoId, memoData)` per row, chunked at 100 rows per `Multicall3From.aggregate3` transaction; simulate a chunk with one `eth_call` (`allowFailure=true`) and read each row's outcome; the gas budget the app checks against. |
| `wallet/` | Classify a sender from its code: plain EOA, EIP-7702 delegated EOA (`0xef0100…`), or contract. |
| `reconcile/` | Turn receipts and logs into ledger lines. USDC is read from Arc's system emitter only, the duplicate ERC-20 log is counted but never summed, EURC is read from its own contract, memos are matched to transfers, and gas is split across a transaction's lines exactly. |
| `export/` | CSV and JSON exports whose footer totals equal the sum of the rows. |
| `errors.ts` | Every failure as one plain sentence and one next step: blocklisted recipient, zero address, gas cap, fee floor, dropped or reverted transaction, rate-limited or pruned RPC. |

`scripts/testnet` and `scripts/mainnet` are the acceptance runs, described below.

## Arc features used, and the traps handled

- **Memo + Multicall3From (`aggregate3`) via the CallFrom precompile.** Every payout row is a Memo call
  wrapping a USDC or EURC transfer, batched through `Multicall3From.aggregate3` so the batch runs from
  your own wallet (not a relayer) and each transaction is atomic: it pays every row in it or none.
- **System-emitter (EIP-7708-style) reconciliation, with the double-log trap.** USDC is Arc's native
  currency. Every native USDC movement, including one made through USDC's ERC-20 interface, is logged by
  a virtual system-emitter address, and a transfer through the ERC-20 interface also gets a `Transfer`
  log from the USDC contract for the same movement. Reading both as payments double-counts it. The ledger
  treats the system-emitter log as the only source of truth for USDC and only counts, never sums, the
  contract's duplicate. This is checked against recorded Arc receipts (a USDC batch that carries three of
  each and reconciles to exactly three payments, and an EURC batch) and by a property test over generated
  receipts with the duplicate logs and unrelated logs mixed in. The trap was first documented by
  [arctools](https://github.com/ilkermanap/arctools), which measured the phantom rows.
- **EIP-7825-aware chunking.** Arc caps a transaction at 16,777,216 gas. About 53k gas per memo'd row
  measured on testnet, so batches are chunked at 100 rows per transaction, and the cap's `-32003` error
  is told apart from a genuine out-of-gas revert.
- **20 Gwei fee floor.** Arc silently drops transactions priced below a 20 Gwei `maxFeePerGas`; the fee
  read from the node is clamped up to the floor rather than trusted when it comes in under it.
- **EIP-7702 senders.** A wallet with an active 7702 delegation is still an EOA at the protocol level
  (`tx.origin`) and can sign a Memo batch; the classifier treats 7702 code as a delegated EOA, not a
  contract.
- **RPC discipline.** Public Arc RPCs need an explicit `User-Agent`; some mirrors prune log history after
  a few days and rate-limit sustained `eth_getLogs`; the client pages log queries and falls back.

## Status

- **Live on Arc mainnet** (chain `5042`) with a testnet twin (chain `5042002`); links at the top.
- **First real payout on Arc mainnet, 2026-09-23:** 3 payments, 3.00 USDC, one transaction from an
  ordinary wallet through the live app, reconciled to the unit (links above).
- **Spike 0:** Multicall3From → Memo preserves the EOA sender on-chain; ~53k gas per row; 100 rows per
  transaction; EIP-7702-delegated senders work.
- **`payout-e2e`** (`scripts/testnet/payout-e2e.ts`, T1–T10): 10 passed, 0 skipped, 0 failed on Arc
  testnet, including a live EURC payout.
- **`import-e2e`** (`scripts/testnet/import-e2e.ts`): 5 of 5 against the signer's live testnet history.
- The library's own suite: money round-trips, batch building and chunking, preflight decoding,
  reconciliation against recorded receipts, the double-count property test, exports (`pnpm test`).
- The hosted app adds its own suite on top (485 tests across the two, including the double-payment
  guard proven under real Postgres connection contention); it is not part of this repository.

## Known limits

- **EOA senders only.** The CallFrom precompile that Memo and Multicall3From rely on requires the caller
  to be `tx.origin`; a smart-contract wallet (Safe, ERC-4337 account) cannot be the sender of a memo'd
  payout. It can still be reconciled.
- **Reconciliation is bounded by the RPC.** Public mirrors rate-limit and some prune history; the client
  pages and falls back, and reports how far a read actually got rather than hanging.
- **Payment links and escrow** are future work, not part of this build.

## Run the library and its tests

Prerequisites: Node ≥ 20.9, pnpm 10.

```bash
pnpm install
pnpm test         # the ledger suite, no network access
pnpm lint         # Biome
pnpm typecheck    # strict TypeScript, every workspace
```

Two scripts run against live Arc testnet and need a funded key in `scripts/testnet/.env`
(`PRIVATE_KEY`, `ADDRESS`, `ARC_TESTNET_RPC`; at least 1 USDC, EURC optional):

```bash
pnpm --filter @memoline/scripts payout-e2e   # T1–T10 acceptance suite
pnpm --filter @memoline/scripts import-e2e   # reconciles the signer's own testnet history
```

`scripts/mainnet/smoke.ts` is the mainnet equivalent of `payout-e2e`'s T1. It signs and sends a real
transaction; it is never run by CI, a person runs it by hand with a wallet set aside for that purpose.

## Security model of the app

- **Non-custodial.** Memoline never holds a private key, a session key, or a token balance. Every payout
  transaction is built as calldata and signed by the operator's own wallet.
- **No server-side signing.** Nothing in the deployment can move funds on its own.
- **Sign-In with Ethereum.** One-use nonces, the message checked against the deployment's own domain and
  chain id, HTTP-only session cookies.
- **No double sending.** A database lease lets one caller build and sign a chunk at a time; a resumed run
  re-checks each row's memo id against the chain before re-sending; the browser re-derives every
  recipient and amount from the calldata the wallet is about to sign and refuses on any mismatch.

## Report a bug

Open an issue in this repository, including the run id or transaction hash if the report involves a
specific payout.

## License

The library in this repository is [Apache-2.0](./LICENSE). The hosted application is proprietary.

## Author

Built and operated by Vijaygopal Balasa ([github.com/vijaygopalbalasa](https://github.com/vijaygopalbalasa)).
Questions, deletion requests and security reports: open an issue on this repository.
