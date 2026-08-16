# Packet — CreditBook L2/L3 pilot (receipt-graph micro-lines + posting credit)

**Date:** 2026-08-16 · **Author:** Claude (architect) · **Implementer:** Codex · **Operator:** Pascal
**Authority:** `CREDIT_LAYER_DESIGN.md` §11 (CW-1..CW-9 ratified 2026-08-16) + CL-1..5.
**Relationship to deployed contracts:** the L1 `CreditPool` (0x903B…6E4B, secured-against-pledge)
is untouched. This packet adds ONE new contract (`CreditBook`) + platform keeper/surfaces.
**Shared dependency:** the consented-transfer admin route from `PACKET_CANARY_RECOVERY.md`
(Change 2) — build it ONCE; whichever PR lands first owns it, the other consumes it.

## 1. CreditBook contract (new, chain-side)

Holds the pilot loan book for BOTH modes. Funded by operator seed deposited into the book's
own AgentAccountCore position (verified primitives, no new AAC surface):

- Seed in: operator transfers USDC to the book → book calls `AAC.deposit(usdc, amount)`
  (operator-only `seed()` wrapper).
- **Cash draw (L2):** `originate(borrower, amountRaw, mode=CASH, termsHash)` → book calls
  `AAC.sendToAgent(borrower, usdc, amountRaw)` — internal ledger move, no gas juggling.
- **Posting draw (L3):** `originate(poster, amountRaw, mode=POSTING, termsHash)` → book calls
  `AAC.sendToAgent(l3PosterWallet, usdc, amountRaw)` where `l3PosterWallet` is the dedicated
  operator posting identity (settable, allowlisted); the keeper then posts the borrower's
  requested job through the external-poster door from that identity. Principal NEVER reaches
  the borrower; a cancelled job refunds the poster identity and the keeper books
  `repayFromRefund(loanId)`.
- `repay(loanId, amountRaw)` — anyone may repay for a loan (transferFrom payer); zero-interest:
  outstanding decreases 1:1, loan closes at 0. The KEEPER's sweep repayments arrive via the
  shared consented-transfer route (borrower AAC → book AAC) followed by `recordSweepRepayment`.
- State per loan: borrower, mode, principalRaw, outstandingRaw, termsHash (borrower's
  SIWE-signed terms, CW-4), originatedAt, closedAt.
- **Chain-enforced caps (settable behind immutable ceilings, D4 pattern):** perWalletCapRaw
  (init 25e6, ceiling 100e6) per mode; bookCapRaw (init 50e6, ceiling 250e6); interestBps
  (init 0, ceiling 2000); repayBps for the keeper reference (init 5000). `l3Enabled` flag
  (init FALSE — flips only after one L2 cohort self-amortizes, CW-8), owner = TreasuryPolicy
  owner (multisig) for ceilings/flags, operator role for originate/keeper calls.
- Underwriting is NOT chain-verified in the pilot (CW-1 platform-trust): the operator-role
  originate carries the platform's limit decision; the chain enforces only caps + terms hash.

## 2. Platform side

- **Underwriting reader:** trailing-30d settled net = Σ `SettlementSplit.workerAmount` from
  logs (CW-2; payout-evidence law — decode logs, never derive from source), hard-zero on any
  slash/upheld dispute in-window. L2 limit `min(cap, 0.5×net)`; L3 limit `min(cap, 1.0×net)`.
- **Consent flow:** borrower SIWE-signs the terms JSON (amount, mode, repayBps, zero-interest,
  deduction disclosure); hash goes into originate; the signed blob is stored and returned by
  the API. Disclosure line verbatim: "deduction-first — up to half of each payout services
  your loan until cleared."
- **Keeper:** after each settlement where the worker has an open CASH/POSTING loan, mint a
  `sendToAgentFor` authorization request for `min(payout × repayBps, outstanding)` — the
  borrower pre-signed a standing authorization set at origination (nonce series, deadline =
  loan term-less → rolling 30d re-sign; if authorization exhausted/expired, sweep pauses and
  the loan simply amortizes slower — NEVER blocks settlement). Submit via the shared route,
  then `recordSweepRepayment`.
- **Surfaces:** extend `getCreditInfo` (limits, outstanding, mode, next-sweep estimate) and
  `buildCreditTransactions` (origination consent + repay templates). Truth-boundary: quote
  the platform-trust nature of the pilot sweep in the disclosure ("the platform submits your
  pre-authorized repayments").
- **L3 posting flow:** borrower supplies the job definition; keeper posts via the existing
  external-poster machinery from `l3PosterWallet`; poster fee NOT waived (CW-7); job carries
  `onboardingWaiverEligible: false`.

## 3. Constants (all initial, all settable)

| Knob | L2 cash | L3 posting |
|---|---|---|
| α vs trailing-30d net | 0.5 | 1.0 |
| Per-wallet cap | 25 USDC | 25 USDC |
| Interest | 0% (ceiling 20%) | 0% |
| repayBps | 5000 | 5000 |
| Book cap (shared) | 50 USDC seed | shared |
| Enabled at launch | yes | NO (flag) |

## 4. Acceptance

1. Fork test: seed → L2 originate (cash lands in borrower AAC liquid) → simulated settlement →
   keeper sweep repays exactly `min(payout×5000bps, outstanding)` → loan closes at 0 → borrower
   withdraw unaffected afterward.
2. Fork test: L3 originate with `l3Enabled=false` reverts; with flag: principal lands at the
   poster identity, cancel refund books `repayFromRefund`, loan closes.
3. Caps: per-wallet + book cap enforced on-chain; ceilings immutable.
4. Sweep-authorization expiry pauses deduction without touching settlement (explicit test).
5. Wash-economics doc-check: the packet's §"structural economics" table (fee 0.05 + retention
   0.05 + worker gas ≈ 0.06 per 0.25 cycle) reproduced in the test constants (CW-9).
6. D-03: new contract enters `deployments/mainnet.json` provenance at its own ceremony —
   deployment is NOT part of this PR (banked-decision discipline; ceremony after gate).

## 5. Explicitly out of scope

AAC-next `creditBroker` debt booking (banked, CW-1c); Rail 2 pool-venue funding (memo-gated);
backing agents (§9 gates); any escrow change (v3 untouched); interest > 0.
