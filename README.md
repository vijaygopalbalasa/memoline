# Memoline

Memoline is a non-custodial back office for stablecoin payouts on [Arc](https://docs.arc.io). You paste a
CSV of recipients, your own wallet signs each batch, and every payment carries an on-chain memo that
Memoline turns back into a reconciled ledger line. There is no custody, no server-held keys, and no fiat —
it only moves and reconciles USDC/EURC that are already on Arc.

## 60-second quick start

1. Open the app and **connect a wallet** (any EOA — see [Known limits](#known-limits)).
2. **Sign in** with SIWE (a free signature, no gas).
3. **Paste a CSV** (`recipient,amount,reference`, one row per payment).
4. Review **validation** results (bad checksums, duplicate recipients/references, amount limits).
5. Run **pre-flight** — one simulated call that shows every row that would fail before anything is sent.
6. **Sign** each chunk in your wallet, reading the safety panel first (network, contract, total, row
   count, estimated fee).
7. Watch the run reconcile from the transaction receipt, then **export** the run and ledger as CSV/JSON.

## Import

`/import` reconciles any Arc address — including ones you don't control — into a read-only ledger view:
paste an address, get back a reconciled list of USDC/EURC movements with references and fees. Nothing is
stored: an anonymous import runs entirely in the request and covers the most recent ~200,000 blocks
(~28 h) or 2,000 entries, whichever comes first, scanned newest-first so a scan cut short by the time
budget still returns recent activity rather than old history, and is best-effort against a public RPC —
it always returns whatever it actually scanned within its deadline rather than hanging (see
[Known limits](#known-limits)). Signing in additionally lets a workspace start a **stored** import that
keeps paging further back in the background (a Vercel cron job continues it in bounded steps) and persists
to that workspace's ledger with full history.

## Arc features used

- **Memo + Multicall3From (`aggregate3`) via the CallFrom precompile.** Every payout row is
  `Memo.memo(token, transfer(recipient, amount), memoId, memoData)`, batched through
  `Multicall3From.aggregate3` so the batch runs from your EOA (not a relayer) and the whole chunk is atomic
  — one call either pays every row in it or none of them.
- **System-emitter (EIP-7708-style) reconciliation, with the double-log trap.** On Arc, native-value
  transfers — including the value side of an ERC-20 transfer — are logged by a virtual system-emitter
  address, *and* the USDC/EURC token contract also emits its own ERC-20 `Transfer` log for the same
  movement. Reading both as separate payments double-counts every transfer. Memoline treats the
  system-emitter log as the only source of truth for value moved and only *counts* (never sums) the
  token contract's duplicate — proven in a fixture receipt that carries three of each and reconciling to
  exactly three payments.
- **EIP-7825-aware chunking.** Arc caps a transaction at 16,777,216 gas. Memoline measured ~53k gas per
  memo'd row on testnet and chunks payout batches at 100 rows per transaction, well under the cap, and
  disambiguates the cap's `-32003` error from a genuine out-of-gas revert.
- **20 Gwei fee floor.** Arc silently drops transactions priced below a 20 Gwei `maxFeePerGas`; Memoline
  reads the current fee from the node and clamps it up to the floor rather than trusting an estimate that
  could come in under it.
- **EIP-7702 sender support.** A wallet with an active 7702 delegation is still an EOA at the protocol
  level (`tx.origin`), and Spike 0 proved it can sign a Memo batch; Memoline classifies 7702 code
  (`0xef0100…`) as a delegated EOA, not a contract, gated by `ALLOW_7702_SENDERS`.

## Status

Verified on **Arc Testnet** (chain `5042002`), never on mainnet:

- **Spike 0** — Mode A (Multicall3From → Memo preserves the EOA sender) confirmed on-chain; ~53k gas per
  row; 100 rows/tx set as the batch cap; EIP-7702-delegated senders work.
- **`payout-e2e` acceptance suite** (`scripts/testnet/payout-e2e.ts`, T1–T10): **9 passed, 1 skipped
  (T8, EURC — the signer holds no testnet EURC), 0 failed.**
- **`import-e2e` acceptance suite** (`scripts/testnet/import-e2e.ts`): **5/5 passed** — 173 entries
  reconciled from the signer's own live testnet transaction history.
- **225 unit/integration tests** across `packages/ledger` and `apps/web` (`pnpm test`): 224 passed, 1
  skipped (the same EURC fixture gap).

Not yet done: no mainnet deployment, no mainnet transaction. The EURC path is implemented and unit-tested
but has never reconciled a live token movement (no testnet EURC was available). Payment links and the
ERC-8183 escrow slice are future work, not part of this build.

## Known limits

- **EOA senders only.** The CallFrom precompile that Memo/Multicall3From rely on requires the caller to be
  `tx.origin`; a smart-contract wallet (Safe, ERC-4337 account) cannot be the sender of a Memo'd payout.
- **Anonymous import scans the most recent blocks, newest first, best-effort within a time budget on a
  public RPC.** No sign-in, nothing stored — capped at the most recent ~200,000 blocks (~28 h) or 2,000
  entries (and 500 enriched receipts, 5,000 raw logs) per address, whichever limit is hit first, against
  whichever public RPC is configured. On a slow/rate-limited public RPC the scan can stop before reaching
  the full window; because it walks backward from the chain head, a scan cut short still returns the
  address's newest activity instead of its oldest. The response always says how far it actually got
  (`scannedFromBlock`, `scannedToBlock`, `complete`) rather than hanging. Sign in for full history via a
  stored import, or configure a provider RPC key (see [DEPLOY.md](DEPLOY.md)) for a faster anonymous scan.
- **Fees are not imported for non-transfer transactions.** Import only attributes a gas fee to entries it
  reconciles from Memo/Transfer logs; other activity by the same address isn't priced into the ledger.
- **EURC is implemented but untested against a live transfer** — see Status.

## Run it locally

Prerequisites: Node ≥ 20.9, pnpm 10, a Postgres database (a local instance or a free [Neon](https://neon.tech)
branch both work).

```bash
pnpm install
cp .env.example apps/web/.env.local   # fill in the values below
pnpm --filter @memoline/web db:migrate
pnpm dev --filter @memoline/web        # or: cd apps/web && pnpm dev
```

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. |
| `SESSION_SECRET` | yes | ≥ 32 chars, random. |
| `WALLETCONNECT_PROJECT_ID` | yes* | Free at [reown.com](https://reown.com). *Skippable only with `ALLOW_PLACEHOLDER_WALLETCONNECT=1`, for secret-less CI builds — never in a real deployment. |
| `CHAIN_ENV` | no | `testnet` (default) or `mainnet`. |
| `ARC_RPC_PRIMARY` / `ARC_RPC_FALLBACK` | no | Mainnet RPC; sensible public defaults are baked in. |
| `ARC_TESTNET_RPC_PRIMARY` / `ARC_TESTNET_RPC_FALLBACK` | no | Testnet RPC; same. |
| `RPC_USER_AGENT` | no | Arc's public RPCs return Cloudflare 1010 without one; a default is set. |
| `ALLOW_7702_SENDERS` | no | Defaults `true` (see Arc features used). |
| `CRON_SECRET` | no locally / yes on Vercel | Authenticates `/api/cron/imports`. |
| `NEXT_PUBLIC_APP_URL` | production only | Canonical deployment URL, used as the SIWE domain. |

See `.env.example` for the full, current list with defaults and explanations.

## Tests

```bash
pnpm test        # 225 unit/integration tests, packages/ledger + apps/web, no network access
pnpm lint         # Biome
pnpm typecheck    # strict TypeScript, every workspace
```

Two more scripts run against live Arc Testnet and need a funded key in `scripts/testnet/.env`
(`PRIVATE_KEY`, `ADDRESS`, `ARC_TESTNET_RPC`; ≥ 1 USDC, EURC optional):

```bash
pnpm --filter @memoline/scripts payout-e2e   # T1–T10 acceptance suite
pnpm --filter @memoline/scripts import-e2e   # reconciles the signer's own testnet history
```

`scripts/mainnet/smoke.ts` is the mainnet equivalent of `payout-e2e`'s T1 (3 rows, 5.00 USDC total) — see
`DEPLOY.md`. It is destructive (it signs and sends a real transaction) and is never run by CI; a person runs it by hand with a wallet set aside for that purpose.

## Security model

- **Non-custodial.** Memoline never holds a private key, a session key, or a token balance. Every payout
  transaction is built as calldata and signed by the operator's own wallet in their own extension/hardware
  wallet.
- **No server-side signing.** There is nothing in the deployment that can move funds on its own.
- **SIWE sign-in.** The nonce is burned atomically on verification (one use), the signed message is
  checked against this deployment's own domain and chain ID (not an attacker-controlled `Host` header in
  production), and the session cookie is HTTP-only and expires after 7 days.
- **A DB lease prevents double-sending a chunk.** Only one caller can hold the lease to build/sign a given
  chunk at a time; it is held until released (or force-reclaimed from the UI) rather than on a timer, so a
  second tab or a slow wallet prompt can't race a chunk into being sent twice.
- **Memo idempotency.** Resuming a run re-checks each row's memo ID against the chain before re-sending
  it, so re-running a chunk that actually landed does not pay it again.

## Report a bug

This is a pre-launch build (no mainnet deployment yet). Open an issue in this repository, including the
run ID or transaction hash if the report involves a specific payout.

## License

[Apache-2.0](./LICENSE)
