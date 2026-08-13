# Packet — CreditPool + L1 secured line (chain-side spec)

**Date:** 2026-08-13 · **Author:** Claude (architect) · **Implementer:** Codex (chain/settlement) · **Operator:** Pascal
**Authority:** `CREDIT_LAYER_DESIGN.md` (RATIFIED, CL-1..CL-5, Pascal 2026-08-13) · D8 addendum
(peer-to-pool, self-custodied, memo boundary) · D6 (pool products are zero-margin stickiness) ·
D0 (vesting semantics, live).
**Requirements-level spec.** Codex owns Solidity and internals; below is behavior, invariants,
events, acceptance.

## 0. Contract-reality finding (drives the timing)

The deployed DepositPool (`0xCCF5FDF3…F476`) has **no pledge surface**: shares are
non-transferable and nothing can block a redeem. A "secured" line against a position that can
walk out through a direct `redeem` call would be secured in name only — the truth boundary
forbids shipping that. **L1 therefore requires a DepositPool v2 with a pledge-aware redeem
path.** The strategic fact that makes this cheap: the pool is days old and has **exactly one
depositor — our own dogfood wallet (10 USDC)**. A v2 migration today costs approximately
nothing; after external depositors arrive it becomes a coordination project. Recommendation
embedded here: schedule the pool-v2 + CreditPool ceremony as the **next pool window, after the
EscrowCore v3 ceremony** (one contract ceremony in flight at a time; v3 keeps priority).

## 1. Scope

1. **CreditPool** — the Rail-1 supply contract (peer-to-pool, operator-seeded).
2. **DepositPool v2** — bit-identical to v1 **plus one narrow surface**: the pledge registry.
3. **L1 loan mechanics** — originate/repay/seize, zero-interest pilot.
4. **Borrow-to-vest ban, enforced platform-side** (D0 calculator change).
5. Origination/door/observability surfaces, same unsigned-template boundary as the deposit door.

## 2. Requirements

**R1 — CreditPool (supply).** ERC-4626-shaped over USDC, the DepositPool skeleton reused:
non-transferable shares, compile-time caps (`TOTAL_ASSET_CAP = 250e6`, `PER_LENDER_CAP = 100e6`),
cost-basis accounting (`totalAssets = buffer + principalOutstanding`), notice-tier redemptions
with the same recallability discipline, `contributeOperatorPrincipal` for the operator seed
(CL-4: the first loans are funded by our capital; first defaults are our cost). Lender deposits
permissionless but **quiet + disclosed** — the pool's exact standing rule, same canonical
disclosure line. `PLATFORM_FEE_BPS = 0` and `interestBps = 0` for the pilot (settable, ceiling
`MAX_INTEREST_BPS = 2_000`; pricing arrives with L2 economics, not before).

**R2 — DepositPool v2 pledge registry.** The **only** delta from v1:
`pledge(shares, loanId)` (owner-only, marks shares pledged to the CreditPool),
`release(loanId)` (CreditPool-only, on full repayment), `seize(loanId, receiver)`
(CreditPool-only, transfers the pledged shares' redemption value to the CreditPool on default).
`redeem`/notice-tier requests **revert for pledged shares** (`SharesPledged`). Everything else
bit-identical to v1 — same caps, tiers, cost-basis, venue machinery — so the migration ceremony
is a redeploy + rewire + one-depositor migration, fork-simmed first per the pool-ceremony
pattern (#1093 discipline, predictions from verified signer nonce, D-03 waiver dance).

**R3 — L1 loan mechanics.** `originate(pledgeShares, amount)`:
`amount ≤ LTV_BPS × min(pledgedAssetValue, vestedRaw(borrower)) / 10_000`, `LTV_BPS = 8_000`
(settable ≤ `MAX_LTV_BPS = 9_000`). Loanable value is capped by **vested** assets, not raw
deposits — unvested principal is not yet a trust signal and cannot collateralize (D0
consistency). Zero interest: repayment = principal exactly. No fixed term (USDC-on-USDC at 80%
with cost-basis pricing has no price risk); the single liquidation trigger is collateral
impairment: if `pledgedAssetValue < outstanding × 105 / 100` (possible only via a venue-loss
writedown), the CreditPool may `seize`. Repay any amount any time; pledge releases pro-rata only
at **full** repayment (partial-release complexity refused for the pilot).

**R4 — Borrow-to-vest ban (platform-side, rides the same deploy).** In D0's vesting calculator:
deposit tranches created **while the wallet has outstanding CreditPool debt do not begin
vesting until the debt clears** (their ramp clock starts at loan-clear time). This breaks the
pledge→borrow→deposit→vest recursion economically and by construction — borrowed liquidity can
never become capacity signal. One platform read (outstanding debt per wallet, fail-closed: if
the credit read fails, new tranches during the failure window vest late, never early).

**R5 — Events.** `LoanOriginated(loanId, borrower, amount, pledgedShares)`,
`LoanRepaid(loanId, amount, outstanding)`, `LoanClosed(loanId)`, `PledgeSeized(loanId,
value)`, `SharesPledged/Released(owner, shares, loanId)`, plus schedule-change events for the
settable knobs. Indexer classifies the full loan lifecycle from logs alone.

**R6 — Surfaces.** Door: `getCreditInfo` / `buildCreditTransactions` (MCP + HTTP,
payload-identical, same SIWE auth, unsigned templates only, self-signed, self-broadcast — the
platform never holds, moves, or relays funds). Authed view: vested, pledged, loanable,
outstanding, and the plain sentence that repayment releases the pledge. Disclosure line
mandatory on every `available: true` response, smoke-asserted exactly like the deposit door.
`explainEligibility` shows pledged-vs-loanable beside the D0 capacity fields. Board: CreditPool
tile set (buffer, outstanding, pledged total, defaults — expected 0). Hermes: no revenue line
(zero-interest pilot); the tile exists so the *absence* of revenue is also visible truth.

## 3. Constants

| Knob | Pilot value | Ceiling |
|---|---|---|
| `TOTAL_ASSET_CAP` | 250_000_000 | compile-time |
| `PER_LENDER_CAP` | 100_000_000 | compile-time |
| `LTV_BPS` | 8_000 | 9_000 |
| `interestBps` | 0 | 2_000 |
| Impairment trigger | 105% | fixed |

## 4. Sequencing (amended 2026-08-13: build parallelized, ceremonies stay ordered)

1. **Build dispatches now** — CreditPool + DepositPool v2 + platform surfaces + fork-sim
   ceremony script touch no files shared with the v3 PR or the earnings door, so the build
   runs in parallel. **Ceremony order is unchanged and strict**: the EscrowCore v3 ceremony
   executes first; the pool-v2 migration ceremony is the next pool window after it.
2. (folded into 1.)
3. Pool-v2 migration ceremony (operator-run): deploy both, rewire wrapper strategy pointer,
   migrate the single dogfood position, decommission pool v1 — trivially cheap **now**,
   expensive later.
4. L1 goes live capped/quiet/disclosed. L2 (receipt-graph lines) waits for the v4
   payout-router window per CL-2; Rail 2 (DepositPool→CreditPool venue allocation) stays
   memo-gated per CL-4.

## 5. Acceptance

1. Fork-sim transcript: v2 + CreditPool at predicted addresses, dogfood position migrated
   byte-exact (shares, tranches, vesting ages preserved), postconditions exact.
2. Pledge tests: pledged shares revert redeem and notice requests; release only via full
   repayment; seize only under impairment; non-borrower cannot pledge others' shares.
3. LTV boundary tests at vested-vs-deposited divergence (fresh unvested tranche cannot
   collateralize).
4. Zero-interest exactness (repay == principal, no dust).
5. Borrow-to-vest ban: a deposit made mid-loan starts vesting only at loan clearance
   (platform test on the D0 calculator).
6. Door parity (HTTP == MCP), disclosure asserted, smoke extended; templates verified against
   intent in the walkthrough script exactly like `scratch-dogfood-deposit.mjs`.

## 6. Out of scope

L2 underwriting and the v4 payout router (CL-2's window discipline), Rail 2 venue allocation
(memo), interest pricing, any human-facing surface, any change to EscrowCore.
