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
| 4 | **Alchemy** — Arc **mainnet and testnet** apps | Archive-node RPC keys for `ARC_RPC_PRIMARY` and `ARC_TESTNET_RPC_PRIMARY`. The public fallbacks baked into `.env.example` work but are rate-limited and (dRPC specifically) cap `eth_getLogs` at ~100 blocks — unsuitable for Import at any real volume. |
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
| `NEXT_PUBLIC_APP_URL` | Your domain | `https://memoline.io` | Runtime, **production only** — without it, SIWE sign-in falls back to trusting the request's `Host` header, which is only safe if the platform strictly rejects a forged `Host` |

## 3. Database migration

Run once against the Neon database, and again after any migration is added later:

```bash
DATABASE_URL="<neon pooled url>" pnpm --filter @memoline/web db:migrate
```

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
5. Add every environment variable from the table above under **Settings → Environment Variables**
   (Production, and Preview if you want preview deployments to work).
6. Deploy.

## 5. Cron

`apps/web/vercel.json` schedules `/api/cron/imports` at `*/5 * * * *` (every 5 minutes) — this is what
continues a signed-in workspace's stored Import in bounded steps after the first inline step.
**`*/5` cron frequency requires a Vercel Pro plan.** On the free Hobby plan, Vercel silently limits cron
jobs to once a day, which means a multi-step Import (anything past ~200,000 blocks) may take a very long
time to finish. If you're on Hobby, either upgrade to Pro or expect slow Import completion for
addresses with a lot of history — the first inline step still runs correctly either way.

## 6. Mainnet smoke test

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
4. Pick 3 real, checksummed recipient addresses you control (or that you're comfortable sending 1–2 USDC
   to) and run:
   ```bash
   SMOKE_RECIPIENTS=0xAaaa...,0xBbbb...,0xCccc... pnpm --filter @memoline/scripts mainnet-smoke
   ```
5. **This is a human-run, one-off step.** It signs and broadcasts a real transaction; it is never run by CI. Confirm the printed explorer link shows 3 successful transfers and the script
   reports `PASS` before treating the deployment as verified.

## 7. Post-deploy checklist

- [ ] `/` loads over the production domain.
- [ ] Sign-in works: connect a wallet, sign the SIWE message, land in `/app`.
- [ ] `/import` reconciles a real mainnet address you paste in (any address with USDC/EURC history —
      doesn't have to be yours).
- [ ] `/stats` responds and shows aggregate counts (zero is fine on a fresh deployment).
- [ ] The mainnet smoke run (step 6) reconciles: 3/3 rows RECONCILED, fees tie out.

## 8. Rollback

Migrations in this cycle are additive-only (new tables/columns, no drops or renames), so rolling back
application code never requires a down-migration: `git revert` the bad commit (or redeploy the last-known
good Vercel deployment from its dashboard) and redeploy. The database schema stays forward-compatible with
the previous code version.
