# RUNSHEET — Ceremony B: bind a venue to pool v2.1

Status: **DRAFT — BLOCKED BY DESIGN until the venue is measured (Pascal, 2026-08-27: measure first)** · 2026-08-27 · Author: Claude
(architect + gate) · Executor: Pascal (every money step and every signature).
Authority: `MEMO_IDLE_BALANCE_ROUTE.md` **Q1″** (the set-once venue setter
exists precisely for this) and `MEMO_POOL_V22_DEPLOYMENT_WINDOW.md`, which
needs a measurement on the live lane.

## SEQUENCING DECISION — measure before binding

**Pascal, 2026-08-27:** do not run this until the venue has a second
measurement. `setVenueAdapter` is permanent, and binding first would marry v2.1
to Hydration on the strength of two epoch-3 observations. The rate and friction
are properties of the **venue and XCM route**, not of which adapter calls them,
so a measurement on legacy v2's adapter yields valid numbers for the same
venue. `PACKET_VENUE_CEREMONY_EXPLICIT_POOL.md` unblocks that.

## Why this, and why now

Pool v2.1 has `venueAdapter() == address(0)`, so it can never earn. The
measurement runsheet was blocked by a guard that turned out to be right: the
ceremony script refuses an unobserved yield ceremony, and the monitor follows
`contracts.depositPool`, which the A6 cutover repointed to **v2.1**. Legacy v2
is therefore unobserved — and measuring there would have measured **the lane we
are retiring**, not the one that will carry the product.

The existing venue adapter cannot be reused: `0xE2801E6C…` reads
`pool() = 0x6061f0aC…` (legacy v2), and that binding is immutable.

## The CREATE cycle — why this is a precomputed pair

```
HydrationDepositPoolAdapter(pool_, lane_)                     ← needs the lane
HydrationUsdcAdapterV22(policy_, asset_, strategyId_, wrapper_, agentAccountCore_)
                                                              ← agentAccountCore_ IS the adapter
```

Mutually immutable, so one address must be predicted from the deployer nonce:

1. Predict the deployer's CREATE address at **nonce N+1** (the adapter).
2. Deploy the **lane** at nonce N, passing that predicted address as
   `agentAccountCore_`.
3. Deploy the **adapter** at nonce N+1, passing the *actual* lane address.

Only the lane needs a prediction. Both contracts hold **no external money at
deploy**, which is exactly why Q1″ accepted this shape for the pair while
refusing it for the pool.

**Gate:** after step 3, verify on-chain that `adapter.lane()` is the deployed
lane AND `lane.agentAccountCore()` is the deployed adapter. If either is wrong,
STOP — the pair is scrap, redeploy rather than bind.

## The signing package — FOUR calls, not one

`setStrategyAdapter` requires `dispatchPaused == true`
(`XcmWrapperV22.sol:123`), and dispatch is **currently live** (verified
2026-08-27). So:

| # | call | why |
|---|---|---|
| 1 | `xcmWrapper.setDispatchPaused(true)` | required precondition for 2 |
| 2 | `xcmWrapper.setStrategyAdapter(<NEW_STRATEGY_ID>, <lane>)` | register the lane |
| 3 | `xcmWrapper.setDispatchPaused(false)` | restore dispatch |
| 4 | `poolV21.setVenueAdapter(<adapter>)` | **SET-ONCE, PERMANENT** |

`setVenueAdapter` needs no policy approval — it validates code length,
`asset() == USDC`, and `lossReporter() != 0` itself.

**Pausing dispatch is a production action.** It halts all XCM dispatch while
paused. Confirm nothing is in flight first: both pools must read
`activeVenueDeploymentId == 0` and the wrapper must have no unsettled request.
Keep the paused window as short as possible — ideally calls 1–3 in one signing
session.

## Call 4 is irreversible

`setVenueAdapter` is **set-once**. Whatever is bound to v2.1 is permanent for
that pool; a future venue change means a **new pool**, not another setter call.
Do not sign call 4 until the pair has been verified on-chain per the gate
above, and until the adapter is the one we intend to live with.

## Open before this is executable

**B1 — DECIDED 2026-08-27: the strategy id is `AAC_IDLE_HYDRATION_V1`.** Names
the purpose rather than a version, matching the `AAC_IDLE_DEPOSIT_POOL_V21`
style already live, and avoids the v2-vs-v2.1 collision that has already
confused one manifest key.

**Legacy lane: DECIDED — leave `HYDRATION_USDC_POOL_V1` registered.** Legacy v2
still holds the tester's 5.026011 and the parked protocol 10.0; leaving its
lane registered keeps a recall path open for that pool. Costs nothing.

**B2 — deployer and cost.** Two CREATEs at roughly 0.9 DOT each per the gas
law, from the ceremony deployer (`op://mainnet-critical/admin-eoa-mainnet/credential`).

**B3 — the D-03 contract-surface gate.** New contracts without manifest entries
fail the deploy closed. The waiver choreography applies, and the waiver-landing
deploy needs `verify_contract_source=1` dispatch because the Tier-1 path-match
early-return skips hash checks.

**B4 — does the measurement follow immediately?** Once bound, v2.1 can deploy
to the venue and `RUNSHEET_VENUE_MEASUREMENT.md` applies to v2.1 instead of v2,
with no tester-fairness problem: v2.1's holders are the operator's own two
positions plus the adapter. **The reimbursement step becomes unnecessary** —
there is no external depositor in v2.1 to make whole.

## What this does NOT do

Does not deploy anything to a venue, does not enable yield, and does not change
any tier or rate. It gives v2.1 a venue it can use, once.
