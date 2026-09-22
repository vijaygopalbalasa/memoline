# SPEC — Stablecoin back-office console on Arc

Working title: `<APP_NAME>` (pick your own; avoid "Arc" or "Circle" in the brand).
Spec date: 2026-09-19. Chain facts below were read from docs.arc.io on that date. **Docs win over this file** wherever they disagree.

One app, three slices, one shared ledger:

| Slice | What the user does | Ships |
|---|---|---|
| 1. Pay | Upload a CSV, pay many recipients in USDC/EURC, download a reconciliation file | Week 1 |
| 2. Collect | Create a payment link, get paid, see it land in the same ledger | Weeks 2–3 |
| 3. Hold | Fund a milestone escrow, release on approval (ERC-8183) | Weeks 4–5, then external review |

---

## 0. Rules for the coding agent

1. Read the project context first (why we are building this, decisions already made, and the priority order for trade-offs; kept in `private/CONTEXT.md`, local only), then read this whole file before writing code. Build slice by slice. Do not start a slice until the previous slice's acceptance tests pass on Arc Testnet.
2. **Run Spike 0 (section 5) first.** Two design decisions depend on its results.
3. Ground truth for anything about Arc is `https://docs.arc.io/llms.txt` and the `.md` version of each docs page. If docs contradict this spec, follow the docs and record the difference in `OPEN_QUESTIONS.md`.
4. All chain addresses live in one file, `src/chain/addresses.ts`, each with a source URL and the date checked. At startup, call `eth_getCode` on every contract address and refuse to run if any returns `0x`.
5. Money is `bigint` everywhere. No floats, no `Number()` on amounts, no `parseFloat`.
6. The app never holds private keys and never holds user funds. Users sign with their own wallets.
7. Nothing personal goes on-chain. Memo data carries opaque IDs and invoice references only. No names, emails or phone numbers.
8. Testnet first. Mainnet only after the launch checklist (section 12).
9. Optional but useful: Circle publishes coding-agent skills for Arc. From docs.arc.io/llms.txt: `/plugin marketplace add circlefin/skills` then `/plugin install circle-skills@circle`. Check that page for the current commands.

---

## 1. Product

**Who it is for.** Small fintechs, PSPs, agencies, DAOs and crypto-native companies that pay and get paid in USDC on Arc and then have to explain every movement to a finance person or an auditor.

**The job.** Move stablecoins in and out of the business and produce books that are correct without manual stitching.

**Principles**

- Non-custodial. Funds go wallet to wallet, or wallet to a public escrow contract. Never through us.
- Zero custom smart contracts in slices 1 and 2. Arc ships two predeployed contracts that do what we need: `Multicall3From` (batching that preserves the caller) and `Memo` (attaches a reference to a call and emits an indexed event). Slice 3 uses the ERC-8183 reference implementation rather than our own escrow.
- The ledger is the product. Every slice writes to one ledger with one reconciliation engine.
- Arc-correct by construction. The known Arc traps (section 3) are handled once, in shared code, with tests.

**Non-goals (for now).** Fiat on/off-ramps, custody, KYC, FX conversion, cross-chain pay-in, tax reports, mobile app, a token.

---

## 2. Verified chain facts (checked 2026-09-19)

Sources: `docs.arc.io/arc/references/contract-addresses`, `/arc/references/connect-to-arc`, `/arc/references/evm-differences`, `/arc/tutorials/send-usdc-with-transaction-memo`, `/arc/tutorials/create-your-first-erc-8183-job`.

### Networks

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 5042 | 5042002 |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://explorer.testnet.arc.io` (also `testnet.arcscan.app`) |
| Native currency | USDC, 18 decimals | USDC, 18 decimals |
| Faucet | — | `https://faucet.circle.com` |

Alternative RPCs exist from Alchemy, QuickNode, dRPC and Blockdaemon. Use a provider as primary and the public RPC as fallback. viem exports `arcTestnet` (needs viem ≥ 2.38) and the docs import `arc` from `viem/chains`; if your viem version lacks `arc`, define the chain by hand with the values above.

### Addresses

| Contract | Mainnet | Testnet |
|---|---|---|
| USDC (ERC-20 interface, 6 dp) | `0x3600000000000000000000000000000000000000` | same |
| EURC (6 dp) | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` | same |
| Multicall3From | `0x522fAf9A91c41c443c66765030741e4AaCe147D0` | same |
| Multicall3 (reads only) | `0xcA11bde05977b3631167028862bE2a173976CA11` | same |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same |
| ERC-8183 reference (`AgenticCommerce`) | **not found in docs — see section 13** | `0x0747EEf0706327138c69792bF28Cd525089e4583` |
| USDC system emitter (EIP-7708 logs, 18 dp) | `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` | same |
| Blocklisted test address | — | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |

The blocklisted test address is index 1 of the public mnemonic `test test test test test test test test test test test junk`. Transfers to or from it revert. Use it in tests.

### Memo ABI (from the official tutorial)

```json
[
  { "type": "function", "name": "memo", "stateMutability": "nonpayable",
    "inputs": [
      { "name": "target", "type": "address" },
      { "name": "data", "type": "bytes" },
      { "name": "memoId", "type": "bytes32" },
      { "name": "memoData", "type": "bytes" }
    ], "outputs": [] },
  { "type": "event", "name": "BeforeMemo", "anonymous": false,
    "inputs": [{ "name": "memoIndex", "type": "uint256", "indexed": true }] },
  { "type": "event", "name": "Memo", "anonymous": false,
    "inputs": [
      { "name": "sender", "type": "address", "indexed": true },
      { "name": "target", "type": "address", "indexed": true },
      { "name": "callDataHash", "type": "bytes32", "indexed": false },
      { "name": "memoId", "type": "bytes32", "indexed": true },
      { "name": "memo", "type": "bytes", "indexed": false },
      { "name": "memoIndex", "type": "uint256", "indexed": false }
    ] }
]
```

- `Memo` event topic0: `0xeb15ee720798341c37739df41be53acfbbf70ae6802dade35457beec6e47a5e4`.
- A memo is emitted only if the inner call succeeds. `sender` is the original wallet, not the Memo contract.
- **The sender must be an EOA. Smart-contract wallets are not supported by Memo.** Read `docs.arc.io/arc/concepts/transaction-memos` for wallet types, nested-memo behaviour, event ordering and guardrails before coding.

### Multicall3From

Docs: "Batches multiple calls like Multicall3, but preserves the original `msg.sender` in each subcall" via the `CallFrom` precompile. Community projects call it with the Multicall3 `aggregate3((address target, bool allowFailure, bytes callData)[])` shape. **Confirm the exact ABI from the verified source on the explorer or from `circlefin/arc-node` under `contracts/src/`** (Memo and Multicall3From sources are reported to be in that tree).

### ERC-8183 (escrow) — functions seen in the official tutorial

`createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) → uint256 jobId` (client) · `setBudget(uint256 jobId, uint256 amount, bytes optParams)` (provider) · USDC `approve(escrow, amount)` then `fund(uint256 jobId, bytes optParams)` (client) · `submit(uint256 jobId, bytes32 deliverable, bytes optParams)` (provider) · `complete(uint256 jobId, bytes32 reason, bytes optParams)` (evaluator) · `getJob(uint256)` · event `JobCreated`. States: `Open, Funded, Submitted, Completed, Rejected, Expired`. Budgets use 6 decimals. The tutorial ABI is partial; take the full ABI (reject, refund, expiry paths, fee config) from `github.com/erc-8183/base-contracts` or the verified contract. The deployed contract may charge platform or evaluator fees, so the provider can receive less than the budget.

---

## 3. Arc rules the code must obey

1. **One asset, two scales.** Native USDC is 18 decimals; the ERC-20 interface is 6. `amount18 = amount6 * 10n**12n`. Never mix them. Display 6 decimals.
2. **Use the ERC-20 interface for sending and for balance reads.** `balanceOf` truncates sub-6-decimal dust; the dust still exists natively. Record it, do not "fix" it.
3. **Count USDC movements once.** Every USDC movement emits a `Transfer` log from the system emitter (18 dp). An ERC-20 `transfer()` also emits a second `Transfer` from the USDC contract (6 dp). For USDC, the system emitter is the single source of truth; ignore the USDC-contract log. For EURC and other tokens, use the token's own log.
4. **A transfer can revert with enough balance.** Blocklisted sender or recipient, zero address, or a self-destructed recipient all revert. Pre-flight every transfer with `eth_call` from the real sender.
5. **Fees.** Gas is paid in USDC and emits no log. Fee = `gasUsed * effectiveGasPrice` from the receipt, in 18-dp units.
6. **20 Gwei floor.** A transaction with `maxFeePerGas` below 20 Gwei is dropped silently: no error, no receipt. Always clamp to at least the floor.
7. **Finality is on inclusion.** One receipt with a block number is final. Check `status` yourself; do not assume libraries throw on revert.
8. **Dropped is a real state.** No receipt after a timeout means check the nonce and the tx hash, then classify as `DROPPED`. Never re-send blindly (see idempotency, 6.6).
9. **No on-chain randomness, repeating timestamps.** `PREVRANDAO` is 0 and blocks can share a timestamp. Order by block number and log index.
10. **RPC limits.** Wide `eth_getLogs` ranges can hang on the public RPC. Page in small block ranges with a cursor and filter by topics.
11. **Per-transaction gas cap.** Arc targets the Osaka fork, which caps gas per transaction (EIP-7825). Batch size is limited; measure it in Spike 0.
12. **Local simulators lie.** Stock `anvil` does not reproduce Arc behaviour. Test against Arc Testnet; if contracts are ever compiled here, use `circlefin/arc-foundry` (`arc-forge`, `arc-anvil`).

---

## 4. Architecture

### Stack (free tiers are enough)

- Next.js (App Router) + TypeScript, deployed on Vercel.
- wagmi + viem, a wallet modal (ConnectKit or RainbowKit). Include Ethereum mainnet in the chain list with a CORS-safe transport, as the Arc docs advise, or ENS lookups break.
- Postgres (Supabase or Neon) + Drizzle ORM.
- Auth: Sign-In with Ethereum. A workspace is owned by a wallet address.
- Background worker for polling (slice 2) and retries: Vercel cron to start; a small Node worker later.
- Tests: vitest for units, a `scripts/testnet/` suite for live Arc Testnet checks.

### Repo layout

```
src/
  chain/        addresses.ts, chains.ts, abis/, clients.ts, fees.ts
  money/        amount.ts (parse/format/convert, property-tested)
  memo/         ids.ts (memoId scheme), encode.ts, decode.ts
  batch/        build.ts (aggregate3 calldata), chunk.ts, preflight.ts
  ledger/       reconcile.ts, entries.ts, export.ts
  payouts/      csv.ts, run-state.ts
  links/        create.ts, detect.ts, webhooks.ts
  escrow/       erc8183.ts, milestones.ts
  app/          routes and UI
scripts/testnet/  spike0.ts, payout-e2e.ts, link-e2e.ts, escrow-e2e.ts
OPEN_QUESTIONS.md
```

### Data model (Postgres)

```
workspaces(id, name, owner_address, created_at)
members(workspace_id, address, role)                      -- owner | operator | viewer
payout_runs(id, workspace_id, sender, token, status, row_count, total_amount6,
            csv_sha256, mode, created_at, submitted_at, completed_at)
payout_rows(id, run_id, row_index, recipient, amount6, reference, memo_id,
            chunk_id, status, exception_reason)
chunks(id, run_id, idx, tx_hash, status, gas_used, effective_gas_price,
       fee_native18, block_number, block_time)
payment_links(id, workspace_id, payee, token, amount6 NULL, reference, memo_id,
              expires_at, single_use, status, webhook_url, webhook_secret)
payments(id, link_id, payer, amount6, tx_hash, memo_index, status, detected_at)
engagements(id, workspace_id, client, provider, evaluator, title, contract_address)
milestones(id, engagement_id, idx, title, amount6, expired_at, job_id, status,
           deliverable_hash)
ledger_entries(id, workspace_id, direction, token, amount6, amount_native18,
               counterparty, tx_hash, log_index, memo_id, source_type, source_id,
               block_number, block_time, fee_native18, note)
chain_cursor(chain_id, stream, last_block)
webhook_outbox(id, link_id, payload, attempts, next_attempt_at, delivered_at)
```

`amount6`, `amount_native18`, `fee_native18`, gas fields are `NUMERIC` or text holding integers. `source_type` is `payout | payment | escrow_fund | escrow_release | escrow_refund`. Unique index on `(tx_hash, log_index)` in `ledger_entries` so nothing is counted twice.

### Memo ID scheme

```
payout row   : memoId = keccak256(utf8("po:"  + runId  + ":" + rowIndex))
payment link : memoId = keccak256(utf8("pl:"  + linkId))
memoData     : compact JSON bytes, e.g. {"v":1,"t":"po","run":"<runId>","row":12,"ref":"INV-204"}
```

`runId` and `linkId` are random 128-bit IDs, not sequential. Keep `memoData` small (target under 256 bytes; check the docs for any limit). References only, never personal data.

---

## 5. Spike 0 — prove the primitives (half a day, testnet)

Write `scripts/testnet/spike0.ts`. It must answer these and write the answers to `OPEN_QUESTIONS.md`:

1. **Batch + per-row memo.** One transaction to `Multicall3From.aggregate3` with three calls, each `Memo.memo(USDC, transfer(recipient, amount6), memoId, memoData)`. Expect: three system-emitter `Transfer` logs with `from` = the sender EOA, three `Memo` events with `sender` = the EOA and the right `callDataHash`.
   A community report from June 2026 claimed `msg.sender` inside a Multicall3From subcall was the Multicall3From contract; the current docs say the caller is preserved. The spike settles it.
2. **Event ordering.** Confirm that the `Transfer` for row *i* sits between `BeforeMemo(i)` and `Memo(i)` in log order. The reconciler depends on this bracket.
3. **Failure semantics.** Repeat with one recipient set to the blocklisted test address: once with `allowFailure=false` (expect whole tx reverts, nothing moves) and once with `allowFailure=true` (record exactly what happens to the other rows and what is emitted).
4. **Gas per row.** Measure gas for 1, 10, 50 and 100 rows. Derive a safe `MAX_ROWS_PER_TX` that stays well under the per-transaction gas cap. Start the app at 50.
5. **EURC.** Same batch with EURC as target. Confirm gas is still paid in USDC and logs come from the EURC contract.
6. **Pre-flight.** Confirm `eth_call` of `transfer` from the sender to the blocklisted address fails, and capture the revert data for the UI message.
7. **Wallet type.** Try from a smart-contract wallet if one is handy; record the failure mode so the UI can explain it.

**Decisions from the spike**

- If 1 and 2 pass → **Mode A**: batched, per-row memos. This is the default.
- If batching works but nested memos do not → **Mode B**: `Multicall3From` of plain `transfer` calls, one `Memo` for the whole chunk, rows matched by log order.
- If sender preservation fails → **Mode C**: one `Memo.memo` transaction per row, sent sequentially. Offer a local CLI for large runs so users are not signing 200 pop-ups.

---

## 6. Slice 1 — Pay (payout runs + reconciliation ledger)

### 6.1 User stories

- As an operator I upload a CSV and see exactly what will be sent, to whom, and what will be skipped and why, before I sign anything.
- I sign one transaction per chunk and watch rows turn final in about a second each.
- I download a reconciliation file I can hand to an accountant: one line per payment, totals that tie out, fees included.
- If my browser dies mid-run, I can resume without paying anyone twice.

### 6.2 CSV format

```
recipient,amount,reference
0xAbc...,125.50,INV-204
0xDef...,40,PAYROLL-2026-09-ALICE01
```

- `recipient`: EIP-55 checksummed address. Reject bad checksums; a typo is an unrecoverable payment.
- `amount`: decimal string, at most 6 decimal places, greater than 0. Reject scientific notation, commas, negatives, more than 6 dp.
- `reference`: up to 64 chars of `[A-Za-z0-9._:-]`. Warn the user that references are public on-chain.
- Token (USDC or EURC) is chosen per run, not per row.
- Limits: 2,000 rows per run to start. Store the SHA-256 of the file.

### 6.3 Validation and warnings

Hard errors: malformed row, zero address, amount out of range. Warnings (user must acknowledge): duplicate recipient, duplicate reference, recipient equals sender, recipient is a contract, total exceeds balance.

### 6.4 Pre-flight

For every row, `eth_call` the exact `transfer(recipient, amount6)` from the sender. Any failure marks the row `EXCLUDED` with a readable reason (blocked recipient, insufficient balance, other). Show a summary: N will be paid, M excluded, total, estimated fee. Re-run pre-flight immediately before each chunk is signed.

### 6.5 Build and send

- Chunk rows into groups of `MAX_ROWS_PER_TX`.
- Mode A calldata per chunk: `aggregate3([{ target: MEMO, allowFailure: false, callData: memo(TOKEN, transfer(to, amount6), memoId, memoData) }, ...])`.
- Chunks are atomic (`allowFailure=false`). A chunk is either fully paid or not at all. This is deliberate: it keeps the books simple.
- Fees: estimate, then clamp `maxFeePerGas` to at least 20 Gwei.
- Refuse to start if the sender address has code (not an EOA) and explain why; offer Mode C guidance.

### 6.6 State machine and idempotency

```
run   : DRAFT → VALIDATED → IN_PROGRESS → COMPLETED | COMPLETED_WITH_EXCEPTIONS | ABANDONED
chunk : READY → SIGNED → INCLUDED_OK | REVERTED | DROPPED
row   : PENDING → EXCLUDED | SENT → RECONCILED | EXCEPTION
```

Persist every transition before and after each wallet call. **Before sending or re-sending any chunk, query `Memo` logs for that chunk's memoIds from the run's start block. If any exist, the chunk already landed: adopt that transaction instead of sending.** Memo IDs make payouts idempotent. A `REVERTED` chunk moved nothing; re-run pre-flight, exclude offenders, rebuild. A `DROPPED` chunk is re-sent only after the memo check and a nonce check.

### 6.7 Reconciliation algorithm

For each `INCLUDED_OK` chunk:

1. Fetch the receipt. Require `status = success`. Record block number, block time, `fee_native18 = gasUsed * effectiveGasPrice`.
2. Parse logs into three lists: system-emitter `Transfer` (USDC), token-contract `Transfer` (only used when token ≠ USDC), and Memo-contract `BeforeMemo` / `Memo`.
3. For each row, find the `Memo` event by `memoId`. Verify `sender` = run sender, `target` = token, `callDataHash` = `keccak256(transfer calldata)` for that row.
4. Inside the `BeforeMemo(i)`…`Memo(i)` bracket, find the one `Transfer` with `from` = sender, `to` = recipient and the right value (`amount6 * 10^12` for USDC on the system emitter; `amount6` for EURC on its own contract).
5. Match → row `RECONCILED`, write one `ledger_entries` line. Any mismatch → row `EXCEPTION` with a precise reason.
6. Never write a ledger line from the USDC-contract `Transfer` log. It is the duplicate.
7. Chunk checks: count of matched transfers = rows in chunk; sum matches; no unexplained transfers from the sender in that transaction.
8. Allocate the chunk fee across rows pro rata by row count, remainder to the first row, so row fees sum exactly to the chunk fee.

### 6.8 Export

CSV and JSON, per run and for any ledger date range:

```
run_id,row,reference,recipient,token,amount,amount_base6,amount_native18,status,
tx_hash,log_index,memo_id,memo_index,block_number,block_time_utc,
fee_usdc_row,fee_native18_row,fee_usdc_chunk,fee_native18_chunk,exception_reason,explorer_url
```

Every numeric column is a plain number a spreadsheet can sum — fee columns are the exact 18-dp
decimal plus the integer native units (`fee_native18_*`), never an annotated string. (Amended
2026-09-22 after the first live run: the original `0.00702 (+910000000000 dust)` form could not be
summed in a spreadsheet, which is the whole point of the export.)

Footer block: rows paid, rows excluded, rows in exception, total paid, total fees, sender, token, chain ID, CSV hash, generated-at. The file must tie out to the cent with no manual edits.

### 6.9 Screens

Connect and sign in → Runs list → New run (upload, validate, pre-flight summary) → Run in progress (chunks and rows updating live) → Run report (totals, exceptions, download) → Ledger (all entries, filters, export).

### 6.10 Acceptance tests (Arc Testnet)

- T1 Three-row happy path: one transaction, three memos, three reconciled rows, export totals equal on-chain totals.
- T2 Blocklisted recipient is excluded at pre-flight with a clear reason; the others are paid.
- T3 Amount with 7 decimals, bad checksum, zero address: rejected at validation.
- T4 Duplicate recipient and duplicate reference: warned, payable after acknowledgement.
- T5 120 rows: split into chunks; kill the tab after chunk 1; resume; nobody is paid twice (memo check proves it).
- T6 Double-count guard: assert the receipt holds both emitters' logs for USDC and the ledger counts each movement once.
- T7 Sender with contract code: blocked with an explanation.
- T8 EURC run reconciles from EURC-contract logs while fees are recorded in USDC.
- T9 Fee in the export equals `gasUsed * effectiveGasPrice` from the receipt.
- T10 `maxFeePerGas` is never below 20 Gwei; a simulated stuck transaction is classified `DROPPED`, not lost.
- Unit: property tests for parse → base6 → native18 → display round trips; no precision loss.

**Done when** all tests pass, a stranger can complete a run from the README alone, and a 5-USDC mainnet run reconciles.

---

## 7. Slice 2 — Collect (payment links)

### 7.1 User stories

- A merchant creates a link for a fixed amount (or open amount) with a reference and an expiry, and shares it.
- A payer opens the link, connects a wallet, pays in one transaction, and sees a receipt.
- The merchant sees the payment in the same ledger, already matched to the reference, and optionally receives a signed webhook.

### 7.2 Payment mechanics (no custom contract)

The pay page sends `Memo.memo(TOKEN, transfer(payee, amount6), memoId(linkId), memoData)` from the payer's EOA. Funds go payer → payee directly. The payer pays a few cents of USDC gas.

### 7.3 Detection

- A worker polls `eth_getLogs` on the Memo contract with topics `[MemoTopic, null, TOKEN, [open link memoIds]]`, in small block ranges from a stored cursor. Only open, unexpired links are polled.
- For each hit: load the receipt, require success, locate the bracketed `Transfer`, and verify `to` = payee. Fixed-amount links also verify `callDataHash` = hash of the exact expected `transfer` calldata.
- Outcomes: `PAID`, `UNDERPAID`, `OVERPAID`, `LATE` (after expiry), `DUPLICATE` (single-use link paid again). Nothing is auto-refunded; the app is non-custodial. A "Refund" button prepares a transfer from the merchant's own wallet with a memo that references the original payment.
- Anyone can emit a Memo with your `memoId`. It only counts when the bracketed transfer really pays the payee.

### 7.4 Fallback for payers who cannot use Memo

Smart-contract wallets cannot call Memo. Offer "Pay with a plain transfer, then paste your transaction hash". Verify: success, a system-emitter transfer from payer to payee for the right amount, mined after link creation, not already claimed by another link.

### 7.5 Webhooks

`POST` JSON `{ linkId, reference, status, token, amount, payer, txHash, blockNumber }` with header `X-Signature: HMAC-SHA256(secret, body)`. Outbox table, exponential backoff, at-least-once delivery, idempotency key = `txHash:logIndex`.

### 7.6 Later (2.1, not now)

Pay from another chain: embed Circle's App Kit Bridge so the payer first moves USDC to their own Arc address, then pays as above. This avoids attributing a cross-chain mint to a link.

### 7.7 Acceptance tests

Fixed-amount happy path · open-amount path · underpay, overpay, late, duplicate · forged memo with a transfer to someone else is ignored · fallback hash flow, including a hash reused on a second link · webhook signature verifies and retries work · link and payout entries appear in one ledger export with no double counting.

---

## 8. Slice 3 — Hold (milestone escrow on ERC-8183)

### 8.1 Model

An engagement has a client, a provider, an evaluator and ordered milestones. **One milestone = one ERC-8183 job.** Funds sit in the public escrow contract, never with us.

### 8.2 Flow per milestone

1. Client: `createJob(provider, evaluator, expiredAt, description, hook = 0x0)`. Read `jobId` from `JobCreated`.
2. Provider: `setBudget(jobId, amount6, 0x)`. The UI checks it equals the agreed milestone amount.
3. Client: USDC `approve(escrow, amount6)` for the exact amount, then `fund(jobId, 0x)`.
4. Provider: `submit(jobId, deliverableHash, 0x)`, where `deliverableHash = keccak256` of a manifest of the delivered files or URLs. Files stay off-chain.
5. Evaluator: `complete(jobId, reasonHash, 0x)` releases funds, or the reject path refunds. After `expiredAt` the refund path in the reference contract applies. Implement every path the full ABI exposes and show the user, before funding, exactly who can do what and when.

### 8.3 Evaluator choice

- Default: the client is the evaluator ("release on approval"). Say plainly in the UI that this favours the client.
- Option: a neutral third-party address both sides agree on.
- Later option: the team's own Judge Protocol (`github.com/vijaygopalbalasa/judge-protocol`), a deterministic evaluator with recomputable verdicts, for milestones whose acceptance criteria are machine-checkable (schema, checksum, text, HTTP endpoint). Parked for now; do not integrate until asked, and only after it has its own safety layer (settlement delay, multi-sig guardian, per-job caps).
- **The app's operators are never the evaluator by default.** Acting as arbiter over other people's money is a legal and liability decision, not a product default.

### 8.4 Privacy

`description` is public and permanent. Put a short title and an ID there. Keep the real scope of work off-chain and store its hash.

### 8.5 Ledger integration

Funding writes `escrow_fund` (client → escrow). Completion writes `escrow_release` (escrow → provider, net of any contract fee). Refund writes `escrow_refund`. All reconciled from system-emitter logs like everything else.

### 8.6 Safety gates (all required before mainnet)

1. A canonical mainnet ERC-8183 address is confirmed (section 13), or you deploy the **unmodified** reference implementation with `arc-foundry`, verify the source on the explorer, document any owner or fee settings, and publish the address.
2. Every state path is tested on testnet: complete, reject, expiry refund, wrong-caller attempts, double funding, budget mismatch.
3. A per-job cap in the UI (start at 500 USDC) until an independent security review of the contract you point at is done.
4. Exact-amount approvals only. Never unlimited approvals.
5. Legal review of offering escrow tooling in the markets you sell to.

### 8.7 Acceptance tests

Full happy path with three wallets · reject and refund · expiry refund · provider sets the wrong budget and the client is stopped before funding · contract fee present and the ledger shows gross, fee and net · cap enforced · each step resumable after a reload.

---

## 9. Cross-cutting requirements

- **Security.** No server-side keys. SIWE sessions, HTTP-only cookies, CSRF protection. Strict validation on every API input. Rate limits on public pay pages. Webhook secrets stored hashed or encrypted. Dependency pinning and lockfile.
- **Transaction safety UI.** Before every signature show: network, contract being called, token, total amount, number of recipients, estimated fee in USDC. Wrong network → block and offer to switch.
- **Errors.** Every failure has a human sentence and a next step. Map known Arc reverts (blocked address, zero address, insufficient funds) to specific messages.
- **Observability.** Structured logs with run, chunk and link IDs. An internal page for stuck chunks, webhook failures and cursor lag.
- **Traction metrics** (you will need these for a Circle grant application): runs, rows paid, links paid, total volume by token, unique senders, unique payees, weekly active workspaces. Aggregate only; nothing personal.
- **Accessibility and mobile.** The pay page must work well in mobile wallet browsers.

---

## 10. Testing strategy

Unit tests for money math, CSV parsing, memo encoding, reconciliation with recorded receipts (save real testnet receipts as fixtures, including one with both emitters' logs). Live testnet scripts for each slice, run before every release. A tiny mainnet smoke test with 5 USDC before each mainnet release. Never rely on a stock local EVM fork for Arc behaviour.

---

## 11. Deployment and cost

Vercel (hobby) + Supabase or Neon (free) + one RPC provider free tier + the public RPC as fallback. Domain and email are the only real costs. Mainnet gas for testing is cents.

Env: `DATABASE_URL`, `ARC_RPC_PRIMARY`, `ARC_RPC_FALLBACK`, `ARC_TESTNET_RPC`, `SESSION_SECRET`, `WALLETCONNECT_PROJECT_ID`, `WEBHOOK_SIGNING_KEY`, `CHAIN_ENV=testnet|mainnet`.

---

## 12. Launch checklist

- All acceptance tests for the slice pass on testnet.
- Mainnet smoke run reconciles to the cent.
- README: what it is, a 60-second quick start, the Arc features it uses (Memo, Multicall3From, system-emitter reconciliation), known limits, how to report a bug. No hype.
- Two-minute demo video: upload CSV → sign → rows final → export opened in a spreadsheet.
- Open-source the repo (MIT or Apache-2.0).
- Submit to Arc Microgrants (needs a live mainnet deployment and a repo; closes 2026-10-14).
- Request an Arc ecosystem listing; bring the demo to Arc technical office hours.
- Terms page: non-custodial software, no warranty, the user is responsible for who they pay and for compliance. Have a lawyer read it before you charge money.

---

## 13. Open questions to resolve

| # | Question | How to resolve | Blocks |
|---|---|---|---|
| 1 | Does Multicall3From preserve the EOA through a nested Memo call? | Spike 0 | Slice 1 mode |
| 2 | Exact Multicall3From ABI and `allowFailure` behaviour | Verified source; `circlefin/arc-node` `contracts/src/`; Spike 0 | Slice 1 |
| 3 | Safe rows per transaction under the gas cap | Spike 0 measurements | Slice 1 |
| 4 | Any size limit on `memoData` | `transaction-memos` concept page | Slices 1–2 |
| 5 | Do EIP-7702-delegated EOAs work with Memo? | Concept page "wallet types"; test | Slices 1–2 |
| 6 | System-emitter address and any pre-upgrade backfill rules | `usdc-system-events` reference page | Ledger |
| 7 | Canonical ERC-8183 address on Arc mainnet, its owner and fee settings | Ask in Arc office hours or Discord; check docs again | Slice 3 mainnet |
| 8 | Public RPC rate and log-range limits on mainnet | Test; prefer a provider endpoint | Slice 2 |
| 9 | Legal position on charging fees for payment and escrow tooling from India | Lawyer | Monetisation |

---

## 14. Build order (tasks to hand to the coding agent, one at a time)

1. Scaffold the repo, chain config, `addresses.ts` with the startup bytecode check, and the `money/` module with property tests.
2. Spike 0. Write results into `OPEN_QUESTIONS.md`. Pick Mode A, B or C.
3. `memo/` and `batch/` modules with unit tests against the spike's recorded receipts.
4. `ledger/reconcile.ts` against those fixtures, including the double-count guard.
5. Database schema and SIWE auth.
6. CSV upload, validation, pre-flight and the run state machine with idempotent resume.
7. Run UI, report and export. Pass T1–T10. **Ship slice 1 to mainnet.**
8. Payment links: create, pay page, detector worker, outcomes, fallback flow, webhooks. Pass the slice 2 tests. Ship.
9. Escrow on testnet end to end. Clear the five safety gates. Then, and only then, mainnet.

After step 7, stop and show it to real users before building more. What they ask for twice goes to the top of the list.

---

## 15. Legal note

This is software that helps people send their own funds from their own wallets. Keep it that way. The moment the business holds customer funds, controls release of someone else's money, touches fiat, or charges a percentage of payment flows, licensing questions start. Get advice before crossing any of those lines.
