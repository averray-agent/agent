# DepositPoolV2 venue marking — findings and recommendation

Repo: `averray-agent/agent` (platform). Contract: `contracts/DepositPoolV2.sol`.
Live pool: `0x6061f0aCcC3AA66AdD9508708dd2285bFFAC5F30` (Polkadot Asset Hub, chain 420420419).
All chain figures below were read live at Asset Hub block **19868771** (2026-08-25T12:01:36Z)
and Hydration block **13792201**, not taken from any dashboard.

---

## 1. What is actually wrong

`totalAssets()` admits the venue leg at historical cost:

```solidity
assets = bufferAssets() + venuePrincipalCostBasis;
```

Live decomposition of the 0.085333 gap the brief describes:

| component | raw | direction | already knowable on Asset Hub? |
|---|---|---|---|
| `venuePrincipalCostBasis` (what the pool sent) | 9.500000 | — | yes |
| `venueAdapter.managedAssets(pool)` (what landed) | **9.400000** | price **overstated** by 0.100000 | **yes — today, on Asset Hub** |
| actual aUSDC at Hydration | 9.414667 | price understated by 0.014667 vs the line above | no — needs a Hydration read |
| **net vs cost basis** | **−0.085333** | price overstated | — |

This decomposition is the central finding, and it splits the problem in two:

**(a) −0.100000 is not a marking problem. It is a missed write-off.**
It is the XCM/swap entry friction from the epoch-2 roll: the pool sent 9.500000 and
9.400000 arrived as aUSDC. That cost was *realised and certain* the moment the deployment
settled on 2026-08-20/21, and the pool's own venue adapter has reported it on Asset Hub
ever since. `settleVenueDeployment` books `received` — USDC that comes *home* — so a
deployment that settles perfectly at the venue reduces `venuePrincipalCostBasis` by
nothing, and the friction stays invisible until recall or write-off. There is already a
correct, correctly-authorised mechanism for this: `writeOffVenueLoss`.

**(b) +0.014667 is the genuine marking problem** — venue yield accrued but unbooked. It runs
in the *opposite* direction (price understated), harms existing holders rather than new
depositors, and is a documented, deliberate design choice ("Yield is deliberately absent
until USDC reaches the buffer", `DepositPoolV2.sol:225`).

The expensive fix — mark-to-market pricing — targets (b), the smaller, opposite-signed half.
The cheap fix targets (a), the larger half, today.

### The honest-price computation at the external deposit

At Asset Hub block **19868506** (the block before the external deposit at 19868507):

| | raw |
|---|---|
| buffer | 10.895226 |
| `venuePrincipalCostBasis` | 9.500000 |
| `venueAdapter.managedAssets(pool)` | 9.400000 |
| `totalSupply` | 20.501328 |
| quoted price (cost basis) | 0.994824 |
| honest price (pool's own adapter book) | 0.989946 |
| honest price (mark to actual Hydration aUSDC) | 0.990662 |

Shares for a 5.000000 USDC deposit, using the contract's own `assets * supply / managed`:

| basis | shares | vs actual |
|---|---|---|
| as quoted and minted on chain | **5.026011** | — |
| priced off the adapter book (9.400000) | 5.050775 | short **0.024764** |
| priced off actual venue value (9.414667) | 5.047128 | short **0.021117** |

The brief's estimate of 0.016802 short is directionally right but understates the harm;
the correct figures are 0.021117 (mark-to-actual) or 0.024764 (mark-to-adapter-book) shares.
The difference is that the brief compared against post-deposit totals. Every price above is
floor-divided, matching the contract's own integer share math, so 0.994824 rather than the
0.994825 a rounded display shows.

**The decisive point: at deposit time the pool's own on-chain venue adapter already
reported 9.400000 against a 9.500000 cost basis, on Asset Hub, in a `view` function the
pool contract itself already calls.** No oracle, no cross-chain read, and no new trusted
party was needed to know this deposit was mispriced. That collapses most of the design
space in the brief.

### Exposure at risk

| holder | shares | who |
|---|---|---|
| `0xdc1Ed106…2EDeC` | 10.000000 | dogfood wallet (ours) |
| `0x6061f0aC…5F30` | 10.000000 | operator principal, held by the pool |
| `0x97450BF6…4b5c` | **5.026011** | **the one genuinely external depositor** |
| `0x60385dD6…c936` | 0.501328 | acceptance/§7 worker (ours) |
| total supply | 25.527339 | |

No locked shares, no pledges, no outstanding redeem requests. Genuine third-party exposure
is ~5 USDC and the pricing harm to it is ~0.021 USDC. That is real, and it is the reason to
act — but it does not justify a contract redeploy, and it should not be allowed to.

---

## 2. The four options, costed

### Option A — multisig write-off of the realised entry friction  ★ do this first

`writeOffVenueLoss(3, 100000)` from the TreasuryPolicy owner
(`0x01E6eed856e989201F4FF6346E18EAb7e46C874C`) reduces `venuePrincipalCostBasis`
9.500000 → 9.400000 and brings the quoted price to exactly the pool's own on-chain venue
book, 0.990907.

* **Cost:** one multisig call. No code, no deploy, no migration. Precedent exists — this is
  the same call executed for epoch 1 (`writeOffVenueLoss(1, 53018)`) and epoch 2 (51,757).
* **Fixes:** 0.100000 of the 0.085333 gap — i.e. the whole overstatement, leaving the price
  *understated* by the 0.014667 unbooked accrual, which is the conservative direction.
* **Authority:** unchanged. The multisig is already the only party that can move price.
* **Weight note:** measure with `api.call.reviveApi.call(...).weightRequired` before building.
  The epoch-1 write-off needed proofSize 242,216, not the pinned 100k.

This is not "recognising an unrealised loss early". The 0.100000 was spent, at the venue,
five days ago. The pool has simply not been told.

### Option B — door-side shortfall gate  ★ ship this alongside A

Refuse to quote or build a deposit when
`venuePrincipalCostBasis − venueAdapter.managedAssets(pool)` exceeds a threshold, and
disclose the mark on every read. Fail closed when the adapter cannot be read.

* **Cost:** one narrow PR in `mcp-server`. No chain interaction, no ceremony, reversible.
* **The gate is inert whenever `venuePrincipalCostBasis == 0`** — i.e. whenever no capital is
  at the venue. It costs nothing in the pool's normal, undeployed state and arms itself
  automatically for the next epoch.
* **Staleness/manipulation:** none introduced. Both inputs are Asset Hub reads at a single
  block tag, already in the pool's trust domain. The gate adds no new trusted party.
* **Limit — state this plainly:** the door is not the chain. A depositor who calls
  `deposit()` directly still mints at the stale price. The gate protects the surface Averray
  actually operates, which is where every external depositor has arrived so far, and it
  makes the mispricing loud rather than silent. It is a mitigation, not a guarantee.

### Option C — recall deployment 3 and pause the venue lane  ★ decision already due

`venuePrincipalCostBasis` → 0 removes the divergence entirely rather than accounting for it.
The pool becomes 100% buffer and `totalAssets()` is exact by construction.

This is not extra work: **deployment 3's `returnBy` is 2026-08-28T16:48:00Z — three days
out** — so it must be recalled or rolled regardless, and the standing memo already records
the lane as ~6.6× wash-negative at this size (weekly yield ≈0.0090 against ≈0.060 roll cost
at 9.5 deployed; break-even ≈62 USDC deployed). Recalling and *not* redeploying until TVL
supports it is the economically correct call independent of this pricing question, and it
happens to make the pricing question moot.

### Option D — mark-to-market pricing in a new pool (v3)

`DepositPoolV2` is immutable: no proxy, no owner, no pause. Changing `totalAssets()` means a
new pool. And because `HydrationDepositPoolAdapter.pool` and the lane's `agentAccountCore`
are both immutable, it means **a new adapter and a new lane as well**, plus a `CreditPool`
repoint, a vesting-tranche migration, and the ~4.5 DOT four-CREATE gas law.

The migration also has to price itself: you would be migrating 25.5 shares across three
holders at *some* price, and picking the wrong one repeats the original sin at 5× the size.

Two sub-designs, and they are not equally good:

**D1 — price off the mark (`totalAssets = buffer + venueMark`). Recommend against.**
The mark's writer is `HydrationUsdcAdapterV22.recordRemotePosition(assets, asOf, remoteRef)`,
gated on `policy.strategySettler(msg.sender)`. That predicate is **`true` for the backend
operator key `0x5a6836c6…5813`** — a hot KMS signer — and **`false` for the multisig**
(verified live). Today only the cold multisig can move the share price, and only downward.
D1 would hand a hot key the ability to move price *in both directions with no timelock*,
which is a clean round-trip drain: mark down → deposit cheap → mark up → redeem. Rate limits
and one-way ratchets do not close it, because the same key writes the bound. **This is a
straight downgrade of the authority model and should not ship.**

Two further defects worth recording: the mark is currently *never refreshed* —
`lane.remotePositionAsOf` reads **0**, meaning `recordRemotePosition` has never been called
on this lane, so `lane.totalAssets()` is the settle-time observation, not a live mark. And
`recordRemotePosition` also sets `totalShares = assets`, so it is entangled with recall share
math, not a pure price feed.

**D2 — gate on the mark, don't price off it. This is the right v3 design.**
Keep `totalAssets() = bufferAssets() + venuePrincipalCostBasis` — preserving the contract's
stated law that cost basis is the only remote value admitted to NAV — and add a *refusal*:

```solidity
error VenueMarkShortfall(uint256 costBasis, uint256 marked, uint256 tolerance);

function venueShortfall() public view returns (uint256) {
    if (venuePrincipalCostBasis == 0) return 0;
    uint256 marked = venueAdapter.managedAssets(address(this));
    return marked >= venuePrincipalCostBasis ? 0 : venuePrincipalCostBasis - marked;
}
// in deposit() and mint(), before minting:
uint256 shortfall = venueShortfall();
uint256 tolerance = managedBefore * VENUE_MARK_TOLERANCE_BPS / 10_000;
if (shortfall > tolerance) revert VenueMarkShortfall(...);
```

The mark becomes a liveness-and-honesty gate, never an oracle. Nobody gains price authority.
The pool refuses to sell shares at a price it can prove is stale, which forces the multisig
to write off before deposits resume — exactly the sequence that should have run on
2026-08-20. Redemptions stay open throughout, because a holder exiting at an *overstated*
price is not the party being harmed and blocking exits is the worse failure.

**Option B is the off-chain prototype of exactly this rule.** Ship B now; if the venue lane
ever resumes at a size that justifies a new pool, D2 is already specified and field-tested.

---

## 3. Recommendation

| # | action | owner | when |
|---|---|---|---|
| 1 | `writeOffVenueLoss(3, 100000)` — recognise the realised entry friction | multisig (TreasuryPolicy owner) | now |
| 2 | Door-side shortfall gate + mark disclosure (Option B) | this PR | now |
| 3 | Make `0x97450BF6…4b5c` whole: **0.024764** shares, or 0.024764 USDC | operator | with 1 |
| 4 | Recall deployment 3 by 2026-08-28T16:48Z; do not redeploy below ~62 USDC | ceremony | ≤3 days |
| 5 | Standing rule: write off `costBasis − managedAssets` at every deploy settlement | runsheet | next epoch |
| 6 | Option D2 in the v3 spec — build only if the venue lane resumes at scale | backlog | not now |

Item 5 is the durable fix. The recurrence cause is that `settleVenueDeployment` recognises
only cash that comes home, so entry friction is structurally invisible until recall. Making
the write-off a mandatory settlement step closes it without any contract change.

Item 3 is deliberately quoted at the adapter-book price (0.024764), not the
mark-to-actual price (0.021117): the adapter book is what the pool itself could prove on
Asset Hub at the deposit block, so it is the figure the depositor was entitled to. Paying
the larger of the two also errs toward the depositor, which is the right way to round when
we are the party that mispriced.

**Do not ship mark-to-market pricing (D1).** It costs a full four-contract redeploy and a
priced migration, it fixes the smaller and opposite-signed half of the gap, and it moves
share-price authority from a cold multisig onto a hot backend key.

---

## 4. What ships in this PR

Option B only. Scope boundaries held:

* The activation gate (`lockedTierActivationGate`) is untouched.
* Locked-tier economics — tier definitions, terms, caps, forfeit/early-exit terms, the
  `fundsMovement: "none"` ledger semantics — are untouched. Locked-tier quotes are **not**
  refused on shortfall: a lock encumbers AAC liquid and mints no pool shares, so it is not a
  money-in-at-a-wrong-price path. They do gain the mark as disclosure, because a lock
  "carries its pro-rata venue gain or loss" and must not show the cost-basis NAV alone while
  the venue adapter contradicts it. The mark is carried **beside** `nav`, not inside it:
  `terms.nav` is part of the hashed consent artifact, and this PR discloses a price without
  changing what a depositor consents to.
* Withdrawals are never gated. Only `direction: "deposit"` refuses.
* The door's existing fail-closed behaviour is preserved and extended: an unreadable venue
  mark while `venuePrincipalCostBasis > 0` refuses the deposit rather than assuming health.
* No contract file is modified. No chain transaction is sent.

**Surplus is disclosed, not gated.** Once `recordRemotePosition` is called, accrued yield
will push `managedAssets` *above* cost basis and the price becomes understated, diluting
existing holders in favour of new ones. That is the pool's documented conservative design,
not a regression, and gating on it would take the door down in the pool's normal earning
state. The door reports it as `surplus`; closing it is Option D2's business, not this PR's.

### Threshold

`shortfall > max(dustFloorRaw, totalAssets × toleranceBps / 10_000)`

Defaults: `toleranceBps = 10` (0.10% of NAV), `dustFloorRaw = 1000` (0.001 USDC).
Env: `DEPOSIT_POOL_VENUE_MARK_TOLERANCE_BPS`, `DEPOSIT_POOL_VENUE_MARK_DUST_FLOOR_RAW`.

Against live state the gate refuses: tolerance is 25.395226 × 10 / 10_000 = 0.025395, and
the shortfall is 0.100000 — through it by ~3.9×. After action 1 the shortfall is 0 and the
door reopens on its own, with no config change and no deploy.
