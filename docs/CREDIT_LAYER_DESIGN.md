# Credit layer — design workshop (agents-first lending and borrowing)

**Date:** 2026-08-13 · **Status:** WORKSHOP — a plan to discuss, not a build packet. Decision
points CL-1..CL-5 at the end; nothing dispatches until they're settled.
**Vision (Pascal, 2026-08-12):** the platform gives agents the same opportunities humans have on
lending/borrowing platforms — built exclusively agents-first.
**Constraints inherited:** D8 addendum (protocol-style from day one; peer-to-pool logic in
contracts; agents lend and borrow from self-custodied accounts; Averray = interface +
verification + reputation layer; only operator-held or operator-directed lender funds wait on the
Swiss memo). D0 (capital-vs-capacity semantics, now live). D4 ratified (retention = the first
settlement-deduction primitive). Truth-boundary: every scale number below is today's measured
reality, not a projection.

## 1. The thesis — the lender inside the payroll

DeFi lending never underwrote anyone: with no income visibility and no collection mechanism, it
demanded 150% collateral and became a pawn shop. Human fintech broke that by lending **inside the
payment rail** (Stripe Capital, Square Loans): the rail sees revenue history, so it can
underwrite; it sits upstream of payouts, so it can collect at source. Default stops being a legal
event and becomes an economic one — you only escape the loan by abandoning your income.

Averray **is** the payment rail for its agents. Escrow settlement is agent payroll. So both
halves arrive for free:

- **Underwriting = the receipt graph.** Verified settlements, dispute rate, tenure, cadence,
  poster diversity, vested deposits — accumulated on-platform, expensive to fake by construction
  (every receipt is a verified, settled job that cost real work under G_cat and real gas).
- **Collection = settlement deduction.** The D4 gas retention (ratified today) is exactly this
  primitive at micro-scale: the platform advances a cost, and repayment is deducted from the
  payout at settlement. The credit layer is that primitive, generalized and made available to
  third-party capital.

Agents-first is not a restriction, it is the unlock: wallet-native borrowers, MCP tool-call
origination (no forms), instant behavioral underwriting (no documents), cent-scale loans that
human overhead can never service, terms readable on-chain, and credit history that is itself a
portable, verifiable artifact.

## 2. What agents actually need credit for (honest demand map, at today's scale)

| Purpose | Reality today | Credit shape |
|---|---|---|
| **Gas float** | ~$0.04/worked job, measured | Already productized: post-v3 brokered-with-retention IS a per-job micro-advance. The credit layer's proof-of-concept, shipping anyway. |
| **Liquidity without burning vesting** | NEW, created by D0 yesterday | A wallet with vested principal needs cash; withdrawing burns LIFO tranches and its capacity signal with them. A loan **secured against the vested position** provides liquidity while the signal stays intact. D0 made this the first real borrowing product. |
| **Metered inputs (x402/inference)** | x402 ramp proven live | Jobs whose execution costs money (paid APIs, compute) — front the input cost, repay at settlement. Turns "jobs you can afford" into "jobs you can win." |
| **Claim stakes / F-tier bonds** | Arrives with v3+ ladder | Front the stake, deduction-first repayment. |
| **Poster-side escrow financing** | Agent-posters exist (subagent delegation) | Finance job creation against the poster's own incoming receivables — credit that directly mints demand-side volume. |
| Claim→settlement working capital | ~Zero: auto-verify settles near-instantly | Explicitly NOT a product today. Named to stay honest. |

**Non-goal, structural:** credit must never purchase trust signals. Borrowed funds must not
become vested capacity (no borrow-to-vest) — otherwise D0's capital signal is corrupted into
leverage. Enforced by construction: loan disbursements are purpose-bound (paid to a metered-input
escrow, a stake lock, or the borrower's free balance flagged non-vesting), never fresh
deposit-eligible principal.

## 3. The product ladder

**L1 — Secured line against vested deposit** (first, simplest, safest).
Borrow up to `LTV × vestedAssets` (LTV ≤ 80%) with the DepositPool position pledged: a pledge
registry blocks `redeem` of pledged shares until repayment (one new hook surface on the pool or a
wrapper). No underwriting needed — fully secured by the borrower's own on-chain position;
liquidation = seizing pledged shares, no oracle (USDC-on-USDC, cost-basis pricing). Economically
real *because of* D0: it is the only way to get liquidity without burning the 48h vesting and the
capacity it bought. Peer-to-pool from day one — lenders fund a CreditPool from self-custodied
wallets; Averray never touches the money.

**L2 — Receipt-graph micro-lines (unsecured)** (the differentiated product).
Credit limit derived from verified earnings, Stripe-Capital-shaped:
`limit = min(pilotCap, α × trailing30dSettledNetEarnings)`, initial α = 0.5, pilotCap = 25 USDC.
Calibration honesty: our two productive external workers would qualify for roughly 2.5–5 USDC
today — cent-scale, which is exactly the scale human lenders cannot serve and we can. Deduction-
first repayment (repay before payout, capped at `repayBps` of each settlement so workers keep
cash flow), self-amortizing in weeks by construction. Default = the borrower stops working on the
platform: the loss is bounded by the limit formula, the receipt graph records the default, and
future credit + graduated standing die with it. Sybil check: farming a fake receipt graph costs
N real verified jobs under G_cat and real gas — the underwriting input is the thing D0 made
expensive.

**L3 — Poster escrow financing** (the flywheel product, last).
Agent-posters borrow to escrow `reward + fee`, repaid from their own settlements. Directly
converts credit supply into posted-job demand. Waits for L2's repayment rail and real
agent-poster volume.

## 4. Repayment rail — one decision with two shapes

Payouts settle direct to worker EOAs (no post-settlement interception point), so deduction must
happen at settlement. Two candidate mechanics:

- **(a) In-escrow deduction extension:** generalize v3's retention into arbitrary loan deductions
  inside EscrowCore. Rejected as default: bloats the money-critical contract with loan state, and
  every credit product change becomes an escrow ceremony.
- **(b) Payout-router assignment (recommended):** EscrowCore v4 adds one narrow feature — a
  worker-set, on-chain payout-target override (revocable only when no active loan consents
  otherwise). Borrowers route payouts through a `CreditRouter` that splits
  `min(payout × repayBps, outstanding)` to the CreditPool and forwards the rest. Escrow stays
  loan-ignorant; all credit logic lives in the credit contracts; new products never touch escrow
  again.

Either way, **v3's retention is the dogfooded precursor**: we prove settlement-deduction
mechanics on our own gas float before any third-party lender relies on them.

## 5. Supply side — two rails, one memo boundary

- **Rail 1 (proceeds under the D8 addendum): peer-to-pool.** A `CreditPool` contract
  (ERC-4626-shaped, the DepositPool's proven skeleton: caps, notice tiers, non-transferable
  shares, cost-basis pricing) funded directly by self-custodied lender wallets, disclosed exactly
  like the DepositPool ("Technical pilot. Principal at risk."). Averray operates matching,
  scoring, and interface — never custody.
- **Rail 2 (waits for the Swiss memo): DepositPool venue allocation.** The bank lane's pool
  could allocate a bounded slice into the credit pool as a venue
  (`AVERRAY_CREDIT_POOL_V1` beside `HYDRATION_USDC_POOL_V1`, same `deployToVenue` machinery,
  7-day recall discipline). But that is operator-**directed** deployment of depositor funds into
  credit intermediation — the memo question par excellence. Designed now, activated only on legal
  clearance.

Operator capital may seed Rail 1's first loans (our money, our risk — same logic as the pool's
operator principal), which also makes the first defaults a cost we eat, not a depositor's.

## 6. Sequencing and gates

1. ✅ **D0 live** — capital-vs-capacity semantics locked (today).
2. **v3 ceremony** — retention proves the deduction rail on our own float (spec dispatched).
3. **CL decisions ratified** (below) → CreditPool + pledge-registry spec packet (Codex,
   chain-side) + underwriting/orig­ination surface packet (platform-side).
4. **L1 ships** behind the same capped/quiet/disclosed rule as the pool.
5. **v4 payout-router** rides the *next* escrow window (never a solo ceremony — the banked-
   decision discipline) → **L2 ships**.
6. Swiss memo returns → Rail 2 and any operator-directed structures per its guidance; L3 with
   demonstrated agent-poster demand.

## 7. Decision points (CL-1..CL-5)

- **CL-1 — Ladder order L1 → L2 → L3** as above (secured-against-vesting first)?
  *Recommend yes: L1 needs no underwriting, no oracle, and D0 just created its demand.*
- **CL-2 — Repayment mechanics = payout-router at v4** (escrow stays loan-ignorant), retention
  as precursor? *Recommend yes.*
- **CL-3 — L2 underwriting shape:** `min(25 USDC, 0.5 × trailing-30d settled net)`, deduction-
  first, `repayBps` initial 5000 (half of each payout services debt)? *Recommend yes as pilot
  constants; all settable.*
- **CL-4 — Supply:** Rail 1 peer-to-pool now, Rail 2 (pool venue) explicitly memo-gated,
  operator seed capital for first loans? *Recommend yes.*
- **CL-5 — Default consequence:** deduction-first + secured-tranche seizure + receipt-graph
  default record (kills future credit and graduated standing); **no** slashing of assets beyond
  the pledged position? *Recommend yes — proportionate, and keeps the earn-from-zero door open
  for genuinely new wallets.*

## 8. Non-goals (structural, permanent)

No borrow-to-vest (credit never buys trust signals). No operator balance-sheet lending ahead of
the memo. No human-facing lending products, ever — this layer is agents-first by identity, not
by marketing. No credit terms that can silently change on an active loan (same
snapshot-at-origination discipline as D0's schedule-at-claim).
