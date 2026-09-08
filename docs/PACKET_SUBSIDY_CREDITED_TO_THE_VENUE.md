# PACKET — Unattested USDC is credited to the venue, and Substrate subsidies cannot be attested

Status: ready for implementation. **LIVE TRUTH-BOUNDARY DEFECT** on a public
page. Two parts, one PR. No contract or manifest change.

## What is on the public pool page right now

`GET https://api.averray.com/pool`, 2026-09-08 ~19:20 UTC:

```
markedAssets    20512187
netShareBacked  19962187
cumulativeNav     550000
venueEarned       550000     ← 100% credited to Hydration
operatorAdded          0
subsidyLedger   entryCount 0
sharePrice       1027551
```

**The page claims the venue earned 0.550000 USDC.** It did not. The operator
transferred 0.60 USDC into the pool at 19:0x UTC (Asset Hub block 20421344,
extrinsic `0x272c0fb8…47b052`, asset 1337, from `121pEreu…EYhyv`) to fund the
cycle-1 write-off. Real AAVE yield on 9.930137 principal since 2026-09-05 is
**~0.0004 USDC**, measured directly from the aUSDC balance.

So the public surface currently overstates venue performance by roughly
**1400×** — an implied ~600% APR. This is the exact failure the truth-boundary
rule exists to prevent, and it is live.

## Defect A — unattested NAV gain defaults to "the venue earned it"

`yield-attribution-service.js` computes
`markedAssets − netShareBackedCapital = venueEarned + operatorAdded`, then
assigns everything the subsidy ledger cannot account for to **`venueEarned`**.
The ledger's own disclosure already admits it cannot be complete:

> "Operator-attested. … Hub USDC emits no Transfer logs, so the ledger cannot
> prove that every contribution is listed."

A ledger that admits it cannot prove completeness must not have its residual
silently credited to the venue. Any USDC arriving at the pool by any route —
operator top-up, a mistaken transfer, a donation, a future sweep of the parked
Hydration float — inflates apparent venue yield.

This is the more important half. It is not specific to today's transfer; it is a
standing misattribution that gets worse every time the pool is topped up.

## Defect B — a Substrate-side subsidy is structurally unattestable

`attestSubsidy` (`yield-attribution-service.js:390–420`) verifies rather than
trusts, which is right: it fetches the EVM transaction **and** receipt, requires
`to == ` the USDC contract with zero native value, decodes the calldata as an
ERC-20 `transfer`, requires the recipient to be the pool, and takes `amountRaw`
from the decoded args.

It therefore only accepts subsidies sent from an **EVM** wallet. An operator
holding USDC in a Substrate wallet — Nova Spektr, the normal case on Asset Hub —
sends `assets.transfer` to the pool's `0xEE`-mapped account. That produces no
EVM transaction, no receipt and no calldata, so the endpoint returns
`yield_subsidy_transaction_unreadable` and the subsidy can never be recorded.

Verified live today: the attestation attempt on extrinsic `0x272c0fb8…47b052`
failed with exactly that code. Authentication and the
`admin:yield-subsidy:attest` capability both passed — the failure is purely the
EVM-only assumption.

Note this is not hypothetical operator error. The pool's own SS58 form
(`14WWMVMGTHrUWxNW7H5f514t19hvTBvWcbGXXUQsMkjFgTTX`, the `0xEE` mapping of
`0x9B35A102…`) is the address any Substrate wallet must use, and it works — the
funds landed correctly. Only the *bookkeeping* rejects that route.

## The fix

### A — stop crediting the residual to the venue

Introduce a third bucket. The split becomes venue-earned, operator-added, and
**unattributed**, where unattributed is the residual the ledger cannot account
for. Surface it explicitly with a statement in the same plain register as the
existing disclosures — something that says the pool observed a NAV gain it
cannot attribute, not something that implies the venue produced it.

`venueEarned` may only carry value the platform can actually tie to the venue:
the adapter's marked position against its cost basis. Everything else is
unattributed until attested.

Do **not** solve this by hiding the gain, and do not make the pool page show a
smaller total than the chain supports. Show the same total, attributed honestly.

### B — accept a Substrate-side attestation, with the same verification standard

Extend `attestSubsidy` to accept an Asset Hub extrinsic hash alongside an EVM tx
hash. Verification must be no weaker than the EVM path — read it from the
Substrate RPC and require all of:

- the extrinsic succeeded (`system.ExtrinsicSuccess`),
- an `assets.Transferred` event with `assetId == 1337`,
- `to` equal to the pool's `0xEE`-mapped AccountId32, derived in code from the
  configured pool address — never a hardcoded SS58 string,
- amount taken from the **event**, not from operator input,
- block number and timestamp read from the block, as the EVM path already does.

Reject anything that does not match, with a distinct reason code. The operator
must not be able to name an amount; the chain names it.

Keep the EVM path exactly as it is.

## Non-negotiables (each pinned by a test)

1. **Mutation, A:** a NAV gain with an empty subsidy ledger reports
   `unattributed`, not `venueEarned`. Assert `venueEarned` is zero when nothing
   ties the gain to the adapter. Prove the test fails against `origin/main`.
2. Attributed venue yield still appears as `venueEarned` when the adapter's
   marked position genuinely exceeds its cost basis — the fix must not zero out
   real yield.
3. **Mutation, B:** a valid Asset Hub `assets.transfer` of USDC to the pool
   attests successfully and its amount comes from the `assets.Transferred`
   event. Change the operator-supplied amount and assert the recorded amount is
   unchanged.
4. A Substrate extrinsic that succeeded but transferred a **different asset**,
   went to a **different recipient**, or **failed**, is rejected — one test per
   case, each with its own reason code.
5. The pool's `0xEE` account is derived from the configured pool address in
   code. Mutation: change the configured pool address and assert the accepted
   recipient changes with it — a hardcoded SS58 must fail this test.
6. The EVM attestation path is byte-identical in behaviour: existing EVM
   fixtures pass unchanged.
7. The public `/pool` payload never reports a `venueEarned` larger than the
   adapter's marked-minus-cost-basis figure. This is the guard that would have
   caught today's defect.

## Live state while this is open

Deposits are open, `venueMark` is `ok`, share price 1.027551, and the pool holds
10.582050 in buffer against 9.930137 deployed. Nothing is at risk and no funds
are stranded — the 0.60 is in the pool, working for depositors. The defect is
**presentational and it is the dangerous kind**: it makes the product look more
profitable than it is.

The over-transfer itself (0.60 against a 0.05 shortfall) is not recoverable —
`bufferAssets()` is the pool's token balance and there is no operator sweep. It
stands as a larger-than-planned subsidy to existing depositors.

## Handback

PR number; green CI; the seven test names; mutation evidence for tests 1, 3 and
5 (each red before, green after); and a live `/pool` read after deploy showing
`venueEarned` at the true venue figure with the 0.60 either attested as
`operatorAdded` or reported as `unattributed`.
