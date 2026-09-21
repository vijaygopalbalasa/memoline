# Deploying Memoline

This is the human's checklist for taking `apps/web` from a laptop to a live mainnet deployment. Nothing
here has been run yet — accounts, Neon, WalletConnect/Reown, Vercel, and the mainnet smoke transaction are
all still to do (see `PROGRESS.md`). Follow it in order; each step assumes the ones before it are done.

## 1. Accounts you need

| # | Account | What it's for |
|---|---|---|
| 1 | **GitHub org** (e.g. `memoline`) | Hosts the public repo; GitHub Actions runs `.github/workflows/ci.yml` (lint/typecheck/test) on push. |
| 2 | **Domain** (e.g. `memoline.io`) | The canonical production URL — becomes `NEXT_PUBLIC_APP_URL` and the SIWE sign-in domain. Attach it to the Vercel project once created. |
| 3 | **Neon** ([neon.tech](https://neon.tech), free tier) | Serverless Postgres for `DATABASE_URL`. Use the **pooled** connection string (`-pooler` in the hostname) — the app opens a connection pool per serverless instance. |
| 4 | **Alchemy** — one app with Arc **mainnet and testnet** enabled | Keyed endpoints for `ARC_RPC_PRIMARY`/`ARC_TESTNET_RPC_PRIMARY`: fast, unthrottled `eth_call`/receipts/balances and no Cloudflare user-agent games. **What it does not give you: log history.** Measured 2026-09-22: Alchemy's *free* tier rejects any `eth_getLogs` span over **10 blocks** on Arc (`-32600`, "Upgrade to PAYG"). The app's transport chain handles that — a wide log query that Alchemy refuses is retried on the fallback in the same call — so Import history still comes from the fallback, QuickNode's public Arc mirror (`rpc.quicknode.*.arc.io`), which serves **10,000-block** spans but rate-limits under load. That is the practical ceiling for Import today on every provider we could find (dRPC: ~100 blocks; Blockdaemon prunes after ~3–4 days; the un-keyed `rpc.mainnet.arc.io` hangs on wide spans). A paid archive plan with a larger `eth_getLogs` cap would make Import faster; raise `PARAMS.logPageBlocks.max` when one exists. |
| 5 | **Reown / WalletConnect Cloud** ([reown.com](https://reown.com), free) | A project id for `WALLETCONNECT_PROJECT_ID`, required by RainbowKit for WalletConnect/mobile wallet support. |
| 6 | **Vercel** | Hosting, the `/api/cron/imports` cron job, and env var storage. |

## 2. Environment variables

Source of truth: `.env.example` at the repo root (covers `apps/web`; never commit a real `.env*` other than
that file). Copy it to `apps/web/.env.local` for local dev, and enter the same names into Vercel's project
settings for deployment.

| Variable | Where to get it | Example | Required at |
|---|---|---|---|
| `DATABASE_URL` | Neon dashboard → pooled connection string | `postgres://user:pass@ep-xxx-pooler.us-east-1.aws.neon.tech/memoline?sslmode=require` | Runtime |
| `SESSION_SECRET` | Generate: `openssl rand -hex 32` | `9f2c...` (≥ 32 chars) | Runtime |
| `WALLETCONNECT_PROJECT_ID` | Reown Cloud dashboard | `2f5a1b...` | **Build and runtime** (RainbowKit's `getDefaultConfig()` throws on a falsy id during the root layout's static prerender) |
| `ALLOW_PLACEHOLDER_WALLETCONNECT` | — | `1` | Build, **only** for a secret-less CI build (`next build` with no real `WALLETCONNECT_PROJECT_ID`). Never set this on the real deployment — WalletConnect/mobile wallets silently don't work. |
| `CHAIN_ENV` | — | `mainnet` (or `testnet`) | Build and runtime |
| `ARC_RPC_PRIMARY` | Alchemy Arc mainnet app | `https://arc-mainnet.g.alchemy.com/v2/<key>` | Runtime (public default works, but rate-limited) |
| `ARC_RPC_FALLBACK` | — | `https://rpc.quicknode.mainnet.arc.io` | Runtime (default is fine) |
| `ARC_TESTNET_RPC_PRIMARY` | Alchemy Arc testnet app | `https://arc-testnet.g.alchemy.com/v2/<key>` | Runtime (public default works) |
| `ARC_TESTNET_RPC_FALLBACK` | — | `https://rpc.quicknode.testnet.arc.io` | Runtime (default is fine) |
| `RPC_USER_AGENT` | — | `memoline/0.1 (+https://memoline.io)` | Runtime (default works; Arc's public RPCs 403 the default Node/Python user agent) |
| `ALLOW_7702_SENDERS` | — | `true` | Runtime (default `true`; Spike 0 verified 7702-delegated EOAs work with Memo) |
| `CRON_SECRET` | Generate: `openssl rand -hex 32` | `a1b2...` | Runtime — required for `/api/cron/imports` to do anything; without it the endpoint returns `503` rather than running unauthenticated (see step 5) |
| `NEXT_PUBLIC_APP_URL` | Your canonical domain | `https://memoline.io` | Runtime, **Production only** — do **not** set it for Preview. Sign-in accepts the request `Host` when it is this host *or* one of the hosts Vercel injects for the deployment (`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL`, `VERCEL_BRANCH_URL`), so `*.vercel.app` and preview URLs work; any other host is rejected. Requires "Automatically expose System Environment Variables" (on by default) |

## 3. Database migration

**One database per `CHAIN_ENV`.** Never point a testnet deployment and a mainnet deployment at the
same database: the ledger and imports carry a chain id, but a shared database makes the cron and the
stats page see both chains' rows, and a testnet→mainnet switch would silently mix them. The live setup
is one Neon project with two branches — `production` (mainnet, Vercel Production) and `testnet`
(Vercel Preview) — each with its own pooled `DATABASE_URL`. Use `sslmode=verify-full` in the URL (the
`pg` driver warns that `require` will stop verifying certificates in a future major).

Run once against each branch, and again after any migration is added later:

```bash
DATABASE_URL="<neon pooled url>" pnpm --filter @memoline/web db:migrate
```

**`DATABASE_URL` must be exported in the shell** (as above, or via `export DATABASE_URL=...` beforehand) —
`drizzle-kit migrate` reads `process.env` directly and does **not** load `apps/web/.env.local`, so having it
set there alone is not enough and the command fails confusingly (hit this running locally: it needs the
variable present in the shell's own environment, not just the app's env file).

Migrations live in `apps/web/src/db/drizzle/` (Drizzle Kit). They are additive-only in this cycle — see
Rollback below.

## 4. Vercel project settings

1. Import the GitHub repo into a new Vercel project.
2. **Root Directory**: `apps/web` (this is a pnpm workspace monorepo; Vercel needs to know the app lives
   under a subdirectory, but still installs from the repo root so workspace packages resolve).
3. **Framework Preset**: Next.js (auto-detected). Leave **Build Command** on its default — Vercel runs the
   `build` script from `apps/web/package.json`, which is already `next build --webpack`.
   **If you ever override the Build Command manually, keep the `--webpack` flag.** `@memoline/ledger`
   ships TypeScript source with relative imports written as `./foo.js` that resolve to the sibling `.ts`
   file; Turbopack cannot follow that mapping ([next.js#82945](https://github.com/vercel/next.js/issues/82945)) — plain `next build` (Turbopack, the Next 16 default) fails on it. `apps/web/next.config.ts` documents this.
4. **Install Command**: default (`pnpm install`) is fine.
5. Add every environment variable from the table above under **Settings → Environment Variables**:
   Production = mainnet (`CHAIN_ENV=mainnet`, the `production` Neon branch, `NEXT_PUBLIC_APP_URL`),
   Preview = testnet (`CHAIN_ENV=testnet`, the `testnet` Neon branch, no `NEXT_PUBLIC_APP_URL`). A
   preview deployment of `main` (`vercel deploy` without `--prod`) is therefore the live testnet app.
6. Deploy.

## 5. Cron

`apps/web/vercel.json` schedules `/api/cron/imports` **once a day** (`0 3 * * *`, 03:00 UTC). This is
what continues a signed-in workspace's stored Import in bounded, deadline-aware steps after the first
inline step (each tick commits whatever pages finished inside its time slice and advances the cursor
exactly that far — a slow RPC means smaller steps, never a killed function that recorded nothing).

**Why daily:** on the Vercel **Hobby** plan a sub-daily cron expression does not get throttled — the
deployment itself **fails** with "Hobby accounts are limited to daily cron jobs" (Vercel docs, *Cron
Jobs › Usage & Pricing*). On Pro, change the schedule to `*/5 * * * *` and stored imports of long
histories finish in minutes instead of days. Until then a stored import past the first inline step
advances one tick per day; the anonymous reconciliation on the landing page is unaffected.

The same file pins functions to `iad1`, the Vercel region adjacent to the Neon project's
`aws-us-east-1`. Keep the two together: the money path holds a row lock across several small
statements, and cross-region latency is what would push it toward the function timeout.

The cron request carries `Authorization: Bearer <CRON_SECRET>` (Vercel injects it from the env var of
the same name); the handler compares in constant time and returns 503 when the secret is unset, 401
when it is wrong. It only continues imports whose `chain_id` matches this deployment's `CHAIN_ENV`.

## 6. Pre-mainnet: verify the chunk-lease suite against real Postgres

**Blocking — do this before the mainnet smoke test below, and again after any change to
`apps/web/src/services/runs.ts`.** The chunk lease is the only thing standing between a concurrent
operator (two tabs, a retry, a force take-over) and paying the same rows twice: Memo has no on-chain
replay guard, so every guard is a `SELECT … FOR UPDATE` on the run row plus a conditional UPDATE.

The default test backend is **PGlite**, a single in-process connection. It executes the SQL, so the
statements are exercised — but it can never produce *contention*: no second connection can block on
the row lock, so a passing PGlite run is not evidence that the locking works. Proven 2026-09-22: a
deliberately broken lease (check-then-set, no run lock) still passes the race test on PGlite and
fails it on Postgres 17 with `['send', 'send']` — a double payment PGlite cannot see.

The suite therefore has a second backend. Set `TEST_DATABASE_URL` to an admin-capable URL on any
**disposable** Postgres (local, Docker, or a Neon branch — never production) and every test database
becomes a clone of a migrated template, served through the production driver (`pg` Pool, 5
connections):

```bash
# creates memoline_tpl_* / memoline_tpl_*_<pid>_<n> databases for the run and drops them after
TEST_DATABASE_URL="postgres://localhost:5432/postgres" pnpm --filter @memoline/web test
```

CI runs this pass on every push against a `postgres:17` service (`.github/workflows/ci.yml`), so a
green `main` already includes it. Run it by hand before a mainnet release anyway; last local run
2026-09-22: 117/117 on PostgreSQL 17.10.

The cases that matter are the concurrent ones in `apps/web/test/runs.test.ts`: two `prepareChunk` calls
racing for one chunk (exactly one may get `kind: 'send'`), `preflightRun`'s rebuild racing a lease
(the rebuild must abort, never re-chunk leased rows), and `settleChunk`'s DROPPED→READY transition
racing a lease. Any two simultaneous `send` results for one chunk is a release blocker.

## 7. Mainnet smoke test

Before announcing the deployment as live, prove one real payout end-to-end on mainnet with
`scripts/mainnet/smoke.ts` (mirrors the testnet `payout-e2e.ts` T1 case, at mainnet stakes — see its
header comment for the full list of pre-flight refusals it runs).

1. **Set aside a separate wallet** for this — never the testnet signer
   (`0x427C62eDCae20DDc8c5e875De39D4E4845491458`; the script refuses to run if the derived address
   matches it) and never a key used anywhere else.
2. Fund it with **at least 6 USDC** on Arc mainnet (5.00 is sent; the rest is headroom, since Arc's native
   gas currency is USDC itself).
3. Create `scripts/mainnet/.env` (git-ignored) with:
   ```
   PRIVATE_KEY=0x...
   ADDRESS=0x...       # must match PRIVATE_KEY exactly
   ARC_RPC=https://arc-mainnet.g.alchemy.com/v2/<key>
   ```
4. **Run this in a clean shell.** `dotenv` (which loads `scripts/mainnet/.env`) never overrides a
   variable that is already set in the environment. If a previous session left `PRIVATE_KEY`, `ADDRESS`,
   or `ARC_RPC` exported from testing something else, the script will silently use that stale value
   instead of the `.env` file's — open a fresh terminal, or `unset PRIVATE_KEY ADDRESS ARC_RPC` first.
5. Pick 3 real, checksummed recipient addresses you control (or that you're comfortable sending 1–2 USDC
   to) and run:
   ```bash
   SMOKE_RECIPIENTS=0xAaaa...,0xBbbb...,0xCccc... pnpm --filter @memoline/scripts mainnet-smoke
   ```
6. **This is a human-run, one-off step.** It signs and broadcasts a real transaction; it is never run by CI. Confirm the printed explorer link shows 3 successful transfers and the script
   reports `PASS` before treating the deployment as verified.

### Resuming an interrupted smoke run

Before it sends anything, the script writes `scripts/mainnet/out/pending.json` (the run id, recipients,
amounts, and the block height right before sending), then rewrites it with the transaction hash the
instant `sendTransaction` returns one. **If the process dies, the terminal disconnects, or
`waitForTransactionReceipt` times out after that point, do not simply re-run the command** — the script
itself already refuses to: as long as `pending.json` exists, it will never send a second transaction.
Instead, just re-invoke the exact same command. It detects the pending file and resumes:

- If `pending.json` has a transaction hash, it looks up that transaction's receipt directly. Found →
  it reconciles and reports on it, deletes `pending.json`, and exits (0 if 3/3 rows reconciled cleanly,
  1 otherwise — either way, the run is now finished, not re-sent). Not found → it prints the hash and the
  explorer link and stops (exit 1); the transaction may still be in flight, so it leaves `pending.json` in
  place and tells you to check the explorer and try resuming again shortly. If the explorer eventually
  shows that hash as dropped/never mined, the only way forward is the manual escape hatch: delete
  `scripts/mainnet/out/pending.json` yourself, then re-run. The script never deletes it for you on this
  branch — "no receipt yet" and "never landed" look identical from here, and guessing wrong re-sends
  real money.
- If `pending.json` has no transaction hash yet (the process died before or during broadcast), it queries
  Arc for `Memo` events matching that exact run's memo IDs from the recorded start block onward. A match
  → it adopts that transaction (someone/something did broadcast it) and reconciles it the same way. No
  match → it reports that the previous attempt never landed and that you may delete `pending.json` by
  hand once you're sure of that, to allow a fresh send; it never deletes the file on your behalf.

`pending.json` is only ever deleted once a receipt has actually been fetched and reconciled — never
speculatively. If you genuinely want to abandon a pending run without waiting (e.g. you know for certain
it was never broadcast), delete `scripts/mainnet/out/pending.json` yourself.

## 8. Post-deploy checklist

- [ ] `/` loads over the production domain.
- [ ] Sign-in works: connect a wallet, sign the SIWE message, land in `/app`.
- [ ] `/import` reconciles a real mainnet address you paste in (any address with USDC/EURC history —
      doesn't have to be yours).
- [ ] `/stats` responds and shows aggregate counts (zero is fine on a fresh deployment).
- [ ] The mainnet smoke run (step 7) reconciles: 3/3 rows RECONCILED, fees tie out.

## 9. Rollback

Migrations in this cycle are additive-only (new tables/columns, no drops or renames), so rolling back
application code never requires a down-migration: `git revert` the bad commit (or redeploy the last-known
good Vercel deployment from its dashboard) and redeploy. The database schema stays forward-compatible with
the previous code version.
