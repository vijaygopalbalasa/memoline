# Memoline

Non-custodial stablecoin back office on Arc. Every payment carries a memo; every memo becomes a line in your books.

Status: cycle 1 in progress. See `PROGRESS.md`.

## Packages
- `packages/ledger` — `@memoline/ledger`, the Arc-correct ledger core (pure TypeScript).
- `apps/web` — the console (Next.js).
- `scripts/testnet`, `scripts/mainnet` — live-chain test scripts.

## Develop
pnpm install · pnpm test · pnpm lint · pnpm typecheck

License: Apache-2.0
