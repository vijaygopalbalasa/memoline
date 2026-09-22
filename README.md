# Memoline

**Live:** mainnet https://memoline-one.vercel.app · testnet https://memoline-testnet.vercel.app

Memoline is a non-custodial back office for stablecoin payouts on [Arc](https://docs.arc.io). You give it
a CSV of recipients, amounts and invoice references; your own wallet signs each batch of up to a hundred
payments; every payment carries its reference on-chain through Arc's Memo contract; and Memoline turns the
receipts back into ledger lines that tie out to the cent. It holds no keys and no funds, and touches no
fiat: it only moves and reconciles USDC and EURC that are already on Arc.

## Try it in two minutes, no wallet needed

1. **Check a payout file.** Open [`/check`](https://memoline-one.vercel.app/check) and press *Try the
   sample file*. Memoline parses the file with the payout's own rules, checks the paying wallet's
   balance, and simulates every payment on Arc from that address, one `eth_call` per transaction of up to
   100 payments: which payments would
   go through, which would be set aside and why, how many transactions you would sign and the most the
   gas could cost. On the testnet twin the sample includes a recipient the USDC issuer has blocklisted, so
   you can see a payment set aside with its reason.
2. **Reconcile any address.** On the [home page](https://memoline-one.vercel.app/#reconcile), press *try
   it with a live example address* (or paste any Arc address). You get its USDC and EURC movements as
   ledger lines: direction, amount, counterparty, the reference decoded from the on-chain memo, and gas
   to the last unit, each movement counted once.
3. **Read a transaction as ledger lines.** Any transaction hash at `/tx/<hash>` is read back the same way,
   which is the page a payer can send to a recipient or an accountant as proof.

## Paying a file (with a wallet)

1. Open the app and **connect a wallet** (a regular wallet such as MetaMask or Rabby; see
   [Known limits](#known-limits)), then sign one message to sign in. Signing in never moves funds.
2. **Upload the CSV** (`recipient,amount,reference`, one row per payment). Every row is checked: address
   and checksum, amount to six decimals, duplicate recipients and references flagged.
3. **Check the batch on Arc.** Your balance is checked against the total plus gas, and every payment is
   simulated from your address; anything that would fail is set aside with its reason before you sign.
4. **Sign** each transaction (up to 100 payments) in your wallet, after reading the review panel: total,
   count, network, contract and estimated gas.
5. The run **reconciles** from the receipts, and the run and the ledger **export** as CSV or JSON, with a
   footer that equals the sum of the rows.

## Import

Reconciling an address you don't sign for works two ways. **Anonymous** (home page and `/import`, no
sign-in): the newest day of Arc (172,800 blocks, or 2,000 entries) is read newest first, so a read cut
short by its time budget still returns recent activity. Nothing is written to a database; the finished
result is held in server memory for five minutes so a repeat request answers at once. **Stored** (signed
in): a workspace imports the last 7 or 30 days of an address into its ledger in bounded steps, continued
from the ledger page or by a daily cron.

## Arc features used

- **Memo + Multicall3From (`aggregate3`) via the CallFrom precompile.** Every payout row is
  `Memo.memo(token, transfer(recipient, amount), memoId, memoData)`, batched through
  `Multicall3From.aggregate3` so the batch runs from your own wallet (not a relayer) and each transaction
  is atomic: it pays every row in it or none of them.
- **System-emitter (EIP-7708-style) reconciliation, with the double-log trap.** USDC is Arc's native
  currency. Every native USDC movement, including one made through USDC's ERC-20 interface, is logged by a
  virtual system-emitter address, *and* a transfer through the ERC-20 interface also gets a `Transfer`
  log from the USDC contract for the same movement. Reading both as payments double-counts it. Memoline
  treats the system-emitter log as the only source of truth for USDC and only *counts* (never sums) the
  contract's duplicate. EURC is an ordinary ERC-20 on Arc, so it is read from its own contract log. This
  is checked against recorded Arc receipts (a USDC batch that carries three of each and reconciles to
  exactly three payments, and an EURC batch) and by a property test over generated receipts with the
  duplicate logs and unrelated logs mixed in. The trap was first documented by [arctools](https://github.com/ilkermanap/arctools), which
  measured the phantom rows; Memoline builds the guard into a ledger and a payout flow.
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

**Live on Arc mainnet** (chain `5042`) at https://memoline-one.vercel.app, with a testnet twin at
https://memoline-testnet.vercel.app (chain `5042002`). Every push to `main` redeploys production.

Verified end to end:

- **Spike 0**: Mode A (Multicall3From → Memo preserves the EOA sender) confirmed on-chain; ~53k gas per
  row; 100 rows/tx set as the batch cap; EIP-7702-delegated senders work.
- **`payout-e2e` acceptance suite** (`scripts/testnet/payout-e2e.ts`, T1–T10): **10 passed, 0 skipped,
  0 failed** on Arc Testnet, including a live EURC payout (T8).
- **`import-e2e` acceptance suite** (`scripts/testnet/import-e2e.ts`): **5/5 passed** against the
  signer's live testnet history.
- **Manual wallet run on the deployed testnet app (2026-09-22):** a 3-row payout and the first
  transaction (100 rows) of a 120-row payout signed in MetaMask; the kill-the-tab, two-tabs-racing,
  reject-in-wallet and wrong-network paths exercised by hand.
- **485 unit/integration tests** across `packages/ledger` and `apps/web` (`pnpm test`), plus the same
  web suite on a real PostgreSQL 17 with connection contention (both run in `.github/workflows/ci.yml`).

Not yet done: the first real payout through the mainnet app. Payment links and the ERC-8183 escrow slice
are future work, not part of this build.

## Known limits

- **EOA senders only.** The CallFrom precompile that Memo/Multicall3From rely on requires the caller to be
  `tx.origin`; a smart-contract wallet (Safe, ERC-4337 account) cannot be the sender of a Memo'd payout.
- **Anonymous import scans the most recent blocks, newest first, best-effort within a time budget on a
  public RPC.** No sign-in, nothing stored. Capped at the most recent ~200,000 blocks (~28 h) or 2,000
  entries (and 500 enriched receipts, 5,000 raw logs) per address, whichever limit is hit first, against
  whichever public RPC is configured. On a slow/rate-limited public RPC the scan can stop before reaching
  the full window; because it walks backward from the chain head, a scan cut short still returns the
  address's newest activity instead of its oldest. The response always says how far it actually got
  (`scannedFromBlock`, `scannedToBlock`, `complete`) rather than hanging. Sign in for full history via a
  stored import, or configure a provider RPC key (see [DEPLOY.md](DEPLOY.md)) for a faster anonymous scan.
- **Import prices gas per transaction the address paid for.** Gas is split pro rata across that
  transaction's lines (the same rule the payout side uses). A transaction the address paid for that
  carried a Memo but moved no USDC or EURC of its own gets a gas-only line, so the fee still appears in the
  books. Transactions with neither a token movement nor a Memo from the address (a plain approval, for
  example) are not read.
- **Stored imports advance in steps.** Each "Continue import" on the ledger page reads another stretch of
  the chain; on the Vercel Hobby plan the automatic continuation runs once a day.

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
| `WALLETCONNECT_PROJECT_ID` | yes* | Free at [reown.com](https://reown.com). *Skippable only with `ALLOW_PLACEHOLDER_WALLETCONNECT=1`, for secret-less CI builds, never in a real deployment. |
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
pnpm test        # 485 unit/integration tests, packages/ledger + apps/web, no network access
TEST_DATABASE_URL=postgres://localhost/postgres pnpm --filter @memoline/web test   # same suite on real Postgres
pnpm lint         # Biome
pnpm typecheck    # strict TypeScript, every workspace
```

Two more scripts run against live Arc Testnet and need a funded key in `scripts/testnet/.env`
(`PRIVATE_KEY`, `ADDRESS`, `ARC_TESTNET_RPC`; ≥ 1 USDC, EURC optional):

```bash
pnpm --filter @memoline/scripts payout-e2e   # T1–T10 acceptance suite
pnpm --filter @memoline/scripts import-e2e   # reconciles the signer's own testnet history
```

`scripts/mainnet/smoke.ts` is the mainnet equivalent of `payout-e2e`'s T1 (3 rows, 5.00 USDC total); see
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

Open an issue in this repository, including the run ID or transaction hash if the report involves a
specific payout.

## License

[Apache-2.0](./LICENSE)

## Author

Built and operated by Vijaygopal Balasa ([github.com/vijaygopalbalasa](https://github.com/vijaygopalbalasa)).
Questions, deletion requests and security reports: open an issue on this repository.
