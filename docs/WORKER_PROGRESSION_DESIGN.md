# Worker progression — what a wallet may consume, and why the pool is the answer

Status: **steps 1 and 3 implemented in the backend; step 2 implemented in source and requires an EscrowCore successor ceremony.** Written after the 2026-08-11 incident, in which one wallet
claimed 33 jobs in minutes, reserved the reward bank's entire liquid balance into escrow, and
kept going on operator-paid gas while holding no DOT of its own.

That agent did nothing wrong — it claimed, worked, and submitted everything. The outage was
ours. But it demonstrated an exposure that would look identical if the actor were hostile,
and we had no way to tell the two apart in the moment.

Related: #1054 (no concurrency bound exists), #1055 (the tier ladder), #1052 (the outage),
`docs/PACKET_AGENT_DEPOSIT_POOL.md` (the pool this feeds).

---

## 1. The ladder

| tier | condition | what the wallet gets |
|---|---|---|
| 0 | first 3 jobs | claim stake waived **and** gas brokered — earn from zero |
| 1 | after 3 | pays its own transaction cost, out of earnings |
| 2 | steady state | a daily allowance |
| 3 | holds pool shares | allowance scales with deposited capital |

Tier 0 already exists (`onboardingWaiverClaimCount = 3`). Tiers 1–3 do not.

---

## 2. The gas subsidy was never capped, and that is the live hole

The waiver caps the **claim stake** at three jobs. It has never capped **gas**. From
`discovery-manifest.js`:

> "Curated starter jobs use operator-brokered claim and submit gas; when one is **also**
> marked `onboardingWaiverEligible`, no funding is required because it needs no bond."

Two independent subsidies; one bounded, one not. A wallet can consume operator-paid gas
forever. Measured 2026-08-02: **0.0748 DOT ≈ $0.059 per job lifecycle**, which is ~24% of a
0.25 USDC reward. The 2026-08-11 wallet cost roughly **$1.95 of DOT** on top of the rewards
it reserved.

### Tier 1 is "pay your own way", not "acquire DOT"

The obvious reading of tier 1 — make the agent fund its own gas — quietly rebuilds the wall
that earn-from-zero exists to remove. An agent that has just finished three jobs holds
**USDC and no DOT**, and acquiring DOT is precisely the step that stops a fresh wallet from
participating.

Retain the **claim fee** instead. The agent pays for its own execution *in USDC out of its
earnings*, we run roughly break-even, and no agent ever touches DOT.

The primitives exist: `EscrowCore.claimFee` / `claimFeeBps`, `AgentAccountCore.slashClaimFee`,
`policy.claimFeeVerifierBps`. What is missing is the policy that retains the fee once a
wallet leaves tier 0 — not the mechanism.

---

## 3. Jobs or value? Neither — cap operator exposure, in USDC

The two candidate units each protect a different resource, and picking one leaves the other
open:

| scarce resource | scales with | what happened on 08-11 |
|---|---|---|
| reward bank liquid | **reward value** | drained to 0.145; six jobs went `reward_funding_pending` |
| brokered gas (DOT) | **job count** | ~$1.95 spent, uncapped |
| board availability to others | job count | board went dark for everyone else |
| verifier throughput | job count | 33-deep queue when the loop died |

A value cap alone ignores gas — and on a 0.05 reward, gas is *more than the reward*. A count
cap alone ignores that five 0.5-jobs is the entire bank.

**So express both in one unit: money at operator risk.**

```
exposure(claim) = reserved reward + brokered gas estimate
cap:  sum of open exposure per wallet  <=  E
```

On today's numbers a 0.05 job costs us ~0.109 of exposure and a 0.5 job ~0.559 — so cheap
jobs are correctly counted as *mostly gas*, which naive value-counting misses entirely.

### The property that makes this the right shape

**The cap loosens by itself as a wallet self-funds.** Once tier 1 retains the claim fee, the
gas component stops being operator exposure — so the same wallet fits more work under the
same `E` without us granting anything. Headroom is earned by no longer consuming the scarce
thing, rather than by permission.

That also means tiers 1–3 are not really separate limits. They are the *same* exposure cap,
seen by wallets that consume different amounts of it.

### Constraints carried forward

1. **Fail visibly.** A wallet at its cap must receive a specific, actionable reason — never
   an empty board. A silent limiter is indistinguishable from having no work, which is the
   failure mode we already decided we cannot afford (`DAILY_OUTFLOW_CAP`, H-1: do not arm).
2. **Set `E` generously.** Latency, not bonding, is the measured throughput constraint. The
   cap exists to stop monopolisation, not to ration demand we are still trying to attract.

---

## 4. Sybil: stop trying to fix tier 0, and bound it instead

Tier 0 is Sybil-vulnerable by construction. A wallet is free and offline to generate — our
own onboarding says so, because that is the point. Any per-wallet free tier can be farmed by
rotating wallets, and the reputation work already established that badges can be
manufactured: we manufactured worker D's ourselves.

Every identity-based defence available to us is purchasable or forgeable, so **making tier 0
Sybil-resistant means killing earn-from-zero.** That trade is not worth it: earn-from-zero is
the differentiator, and it is what makes us better than managed-wallet platforms.

### The decomposition that resolves it

Sybil resistance is only needed where we are *giving something away*.

- **Tier 0 — exposed by design.** Do not gate it per wallet. Bound the **aggregate daily
  onboarding subsidy** instead: at most `S` USDC/day of free-tier gas and waived stake across
  *all* wallets. Rotation then drains at most `S` per day rather than an unbounded amount.
  It converts an open-ended leak into a budgeted marketing cost, which is what it always was.
- **Tiers 1–2 — no identity needed.** The wallet pays its own execution. A rotating wallet at
  tier 1 costs us nothing, so there is nothing to defend.
- **Tier 3 — Sybil-resistant by construction.** See below.

When `S` is exhausted, say so plainly: *"the free tier is fully allocated for today; a wallet
that pays its own claim fee can continue."* Honest, and it converts a limit into a path.

---

## 5. The deposit pool is our Sybil bound, not a yield product

This is the part worth carrying into the banking lane.

Deposited capital is **the only unforgeable signal we have.** Reputation can be manufactured,
wallets are free, client names identify software rather than operators, and on-chain history
can be bought. Capital cannot be duplicated by rotation — splitting a deposit across ten
wallets leaves ten tenth-sized allowances.

So gating throughput on pool shares is not a monetisation bolt-on. It is the only Sybil
mechanism available to us that does not compromise earn-from-zero, and it happens to also be
a product.

Three things fall out:

1. **It answers the pool's open question.** The packet could not say why an agent would
   deposit *before* yield means anything at our size. "Deposit to work more" is a reason on
   day one; "deposit for yield" is not.
2. **It inverts the two workstreams.** The banking lane stops being a speculative side
   product and becomes the throughput gate for the marketplace. The pool earns its place
   whether or not the yield is ever interesting.
3. **It should scale continuously, not as a binary unlock.** Allowance proportional to shares
   held makes the Sybil bound smooth: there is no threshold to game, and splitting capital is
   exactly neutral rather than exploitable.

### Blocking dependency

Tier 3 cannot ship until **#1051** is resolved. The pool is blocked because any
`strategySettler` can set its share price arbitrarily via the lane's `recordRemotePosition`,
which would let a settler mint claims on the buffer. A Sybil bound built on a book that a
privileged role can rewrite is not a bound.

Sequence: fix pool pricing (#1051) → deploy pool → then tier 3.

---

## 6. What is buildable now, in order

1. **Cap aggregate tier-0 subsidy** (`S`/day, global). Smallest change, closes the
   unbounded-gas leak immediately, needs no identity work. Must fail visibly.
2. **Retain the claim fee post-tier.** Primitives exist; this is policy. Turns tier 1 from
   "acquire DOT" into "pay out of earnings" and preserves earn-from-zero.
3. **Per-wallet exposure cap `E`** (reserved reward + brokered gas). Bounds monopolisation in
   the unit that actually matters, and self-loosens as wallets self-fund.
4. **Tier 3 — allowance proportional to pool shares.** After #1051.

## 6.1 Step-2 deployment boundary

The retained-fee policy changes `EscrowCore` runtime bytecode. Merging its source does **not**
change the live mainnet contract and a normal production deploy must not pretend otherwise.
Activation requires a separate, multisig-gated EscrowCore successor ceremony:

1. deploy the successor against the existing `TreasuryPolicy`, `AgentAccountCore`,
   `ReputationSBT`, and treasury account;
2. byte-verify the runtime and record its provenance in `deployments/mainnet.json`;
3. grant the successor `settlementBroker`, `reputationWriter`, and `escrowOperator` authority;
4. point new-job creation and the backend at the successor only after those live reads pass;
5. retain the prior EscrowCore's roles during its drain window so existing jobs can finish;
6. prove on a non-waived claim that the stake returns, the claim fee is retained using
   `claimFeeVerifierBps`, and no fee is charged to a waived tier-0 claim;
7. delete `knownUnshippedContractChanges.escrowCore` and
   `knownUnshippedContractChanges.legacyEscrowCore` from `deployments/mainnet.json`, then
   revert the corresponding pin in `scripts/ops/check-contract-source-drift.test.mjs`.

Until that ceremony, `scripts/ops/audit-launch-readiness.mjs --profile mainnet` correctly
reports `bytecode_selector_missing` for EscrowCore because live v2 does not expose
`retainsClaimFeeOnSuccess()`.

That ceremony is deliberately outside the source PR. No contract deployment, role mutation,
backend cutover, or existing-job migration is implied by merging the implementation.

Steps 1 and 2 together would have prevented the 08-11 exposure. Step 3 would have prevented
the board going dark for other agents. Step 4 is the durable answer.

### Step-3 implementation boundary

The backend enforces `WORKER_OPEN_EXPOSURE_CAP_USDC` at both `preflightJob` and the serialized
claim mutation. The reviewed default is **2.5 USDC**: one quarter of the current roughly
10-USDC reward bank, generous enough for ordinary sequential work while preventing one wallet
from reserving the whole rail. It is a committed, non-secret deployment setting and changes
to it are therefore reviewable rather than hidden in runtime state.

Exposure is derived from immutable claim snapshots and live EscrowCore state:

- open curated work contributes its reserved reward;
- waived or predecessor-runtime claims also contribute the measured brokered-gas estimate;
- after the Step-2 successor advertises `retainsClaimFeeOnSuccess()`, non-waived claims stop
  contributing brokered gas because the retained USDC fee pays that execution cost;
- external poster-funded, worker-signed claims contribute neither operator reward nor gas;
- an unreadable chain job, unsupported FX asset, or active legacy session without a snapshot
  makes exposure unknown and refuses the claim rather than counting it as zero.

The claim path takes a durable wallet-scoped lock around the final exposure read and chain
write. That serialization is load-bearing: two different jobs cannot both pass against the
same stale headroom. The specific refusal codes are `worker_open_exposure_cap_reached`,
`worker_open_exposure_unavailable`, and `worker_exposure_check_in_progress`.

### Tier-2 daily allowance implementation boundary

The steady-state daily allowance uses the same USDC exposure unit as the open cap, but over a
rolling 24-hour claim window. `WORKER_DAILY_EXPOSURE_BUDGET_RAW` defaults to **1,500,000**
(1.50 USDC). Each successful curated claim records reserved reward plus brokered-gas estimate
on its durable session. That spend remains in the window after resolution, rejection, or
expiry and ages out exactly 24 hours after claim time; settlement only releases the separate
open-exposure cap. A configured zero refuses all curated claims.

Both preflight and the serialized claim mutation call `resolveDailyExposureBudget(wallet)`.
The resolver returns the flat tier-2 budget today and is the seam where pool-share-backed
tier-3 allowance can later be added without changing the ledger. The refusal code is
`daily_exposure_budget_reached`, with the remaining allowance and oldest entry's age-out in
the response. Unreadable or inconsistent durable history refuses with
`daily_exposure_budget_unavailable` rather than treating missing spend as zero.

---

## 7. What this design does not solve

- **Sybil at tiers 1–2 for non-subsidised harm.** A rotating wallet still consumes board
  positions and verifier capacity even when it pays its own gas. The exposure cap bounds
  *our money*, not *others' access*. If board monopolisation by self-funded wallets becomes
  real, that needs its own answer.
- **Collusion between poster and worker.** Out of scope here.
- **Whether one agent doing 33 jobs is bad at all.** It may be exactly what success looks
  like. These caps are calibrated to bound a hostile actor without throttling a good one, and
  that calibration is a judgement we should revisit with evidence rather than assume.
