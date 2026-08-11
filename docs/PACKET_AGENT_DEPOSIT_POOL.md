# Packet — the agent deposit pool

**Design:** [`BANK_DEPOSIT_PRODUCT_DESIGN.md`](BANK_DEPOSIT_PRODUCT_DESIGN.md) ·
[`BANK_PHASE2_PROGRAM.md`](BANK_PHASE2_PROGRAM.md) (D1–D8)
**Owner:** Codex implements · Claude gates · Pascal signs the deployment
**Decisions taken 2026-08-10:** separate pool contract (ERC-4626 shape), flat advance
pricing at launch, non-transferable shares.

## Goal

An agent lends its USDC to the pot in exchange for access to things non-depositors cannot
have. It signs every step itself, and we cannot move its money without it.

---

## 1. What was already decided, and what this packet adds

`BANK_PHASE2_PROGRAM.md` closed most of this on 2026-08-02 and the later deposit design did
not re-read it. Restating so nobody re-opens settled ground:

| | decision | source |
|---|---|---|
| D1 | **Shares from minute one**, agent earns the pool's true blended rate | closed 2026-08-02 |
| D2 | **0% platform fee** on agent yield at launch | closed 2026-08-02 |
| D3 | Caps: **pool 1,000 USDC / agent 100 USDC** | closed 2026-08-02 |
| D6 | **Explicit opt-in only, per agent.** Never auto-enroll | closed 2026-08-02 |
| D7 | Physical movement **epoch-batched**; buffer doubles as instant-withdrawal liquidity | closed 2026-08-02 |
| D8 | Operator principal and earned fees are **separate ledger lines** | closed 2026-08-02 |
| — | Withdrawal is **tiered**, agent chooses; **reserve 100% at launch** | decided 2026-08-09 |

**New here (2026-08-10):**

- **P1 — a separate pool contract, ERC-4626 shape.** Not a field on the AAC successor.
- **P2 — shares are non-transferable.**
- **P3 — advance pricing is flat at launch**, with a written exit condition to per-agent.
- **P4 — the relaxation evidence must come from *independent* depositors**, not merely
  distinct ones.
- **P5 — rung 1 is gated behind opting in.** It is the day-one reason to deposit.
- **P6 — two notice tiers, 7 and 30 days**, alongside instant.
- **P7 — build now.** Not gated on a demand signal.

**Also corrected:** the ceremony this was said to ride is now two items, not three.
MAIN-006 closed in #688; both bank docs still say "bundled with MAIN-006 and
`cancelOpenJob` v3 — one ceremony, not three."

---

## 2. The consequence that changes the schedule

`AgentAccountCore.withdraw(asset, amount)` is `external`, operates on
`positions[msg.sender][asset]`, and transfers to `msg.sender`. An agent can already move
its own liquid balance out, today, with its own signature.

So opting in is **three transactions the agent signs itself**:

```
1. AgentAccountCore.withdraw(USDC, amount)     exists today, unchanged
2. USDC.approve(DepositPool, amount)
3. DepositPool.deposit(amount, receiver)
```

Three things follow, and they are the argument for P1:

**No AAC change is required.** The deposit product does not ride the AAC-successor
ceremony, does not wait on the migration design (parallel-run vs snapshot-credit), and
does not bundle with `cancelOpenJob` v3. It ships on its own timeline.

**`sendToAgentFor` is never touched.** The design said not to build pooling on top of the
MAIN-006 surface. This does not merely avoid it — it has no reason to go near it.

**Opt-in stops being a promise.** There is no code path by which the operator moves an
agent's balance into the pool, because the only path starts with the agent's own
`withdraw`. The design's claim — *"the difference between a bank and a custodian who
quietly uses your money"* — becomes enforced by absence rather than asserted in a runbook.

---

## 3. The contract

### Shape

ERC-4626 **shape**, not compliance: `deposit`/`mint`/`redeem`/`convertToAssets`/
`convertToShares`/`totalAssets` with their standard meanings, so the accounting is legible
to any auditor or agent that already reads vaults. Shares are ERC-20 for reads and events;
**`transfer` and `transferFrom` revert** (P2).

Why non-transferable: a transferable claim is a tradeable instrument, creates a secondary
market we did not intend to run, and breaks the depositor↔agent mapping that the reserve
evidence in §5 depends on. Relaxing this later is additive; unwinding it is not.

### D1 falls out rather than being computed

The pool holds a liquid buffer and deploys the rest through the existing Aave-via-Hydration
adapter. Pricing NAV is local buffer cash plus the pool's own deployed-principal cost basis;
remote venue observations never reprice shares. Yield enters `totalAssets` only when USDC
returns to the buffer, so the share price rises on realised cash rather than a settler's
assertion. **The "true blended rate" is emergent** — deployed capital earns the venue rate,
the buffer earns zero, and realised returns become the blend without promising a rate.

This conservative accounting intentionally leaves deposits and redemptions open while
capital is deployed: unobserved yield understates value and cannot create claims on cash the
pool does not hold. Known seam: realised yield lands as a step, so depositing immediately
before a profitable recall and redeeming after can capture yield the depositor did not earn.
It is negligible at the 10 USDC launch size and must be redesigned before material scale.

### Tiers

Three redemption modes (P6):

| tier | redemption | backing |
|---|---|---|
| instant | `redeem` synchronously against the buffer | liquid or very-short-clock deployment |
| notice 7d | `requestRedeem` → fulfilled after 7 days | Aave-deployed, still 100% backed |
| notice 30d | `requestRedeem` → fulfilled after 30 days | Aave-deployed, still 100% backed |

Both notice tiers ship **from day one**. They carry no leverage at launch and their only job
is to start generating the withdrawal profile §5 depends on — two tiers because the point of
letting an agent price its own liquidity preference is to learn what it prefers, and one
tier measures nothing but itself.

7 days is deliberately the `DISPUTE_WINDOW` we already exercise end to end, so the number is
familiar inside our own system rather than invented for this.

A plain per-share time-lock is sufficient; full ERC-7540 machinery is not required and
should not be built speculatively.

**Watch the split.** Two tiers across a tiny depositor population weakens both samples. If
one tier attracts nobody, that is itself a finding — record it rather than quietly merging
the buckets to make the evidence look thicker.

### Caps (D3), enforced in contract

```
totalAssets()                  <= 1_000e6     // 1,000 USDC
assetsOf(agent)                <=   100e6     // 100 USDC
```

### The reserve law, enforced by absence

Law 6 says commitments redeemable on demand may only be backed by clocks we control, and
that a reserve ratio living in a runbook is not a reserve ratio.

The strongest available enforcement at launch is not a ratio check that could be
misconfigured — **it is that the pool has no function that lends**. Advances (rung 3) and
gas/bond borrowing (rung 4) are funded from operator capital and must not be reachable from
pool assets. Adding a lending path later is a new deployment, which is precisely the
design's "one step at a time, enforced in contract before it takes effect."

So: **no `borrow`, no `lend`, no operator-callable asset egress except adapter deployment
to venues on our own clock.** A ratio parameter is added when there is something to ratio.

### Books hygiene (D8)

Operator-contributed principal and earned protocol fees stay separate ledger lines in the
pool's own accounting. A top-up must never read as yield. Fee is 0% at launch (D2), so the
fee line exists and reads zero — it is not absent.

---

## 4. Advance pricing — flat at launch (P3)

The design left this open, noting per-agent is better economics and *"needs reputation to
be trustworthy first."* That condition is not met and we know exactly why: **we manufactured
worker D's badges ourselves.** Reputation here is currently manufacturable, and pricing
credit off a manufacturable signal is an invitation to farm it — spin up agents, build cheap
history, take advances, default.

Flat is tolerable because rung 3's exposure is bounded by construction: the escrow already
exists, so the only uncertainty is the verification outcome, and the loss is the haircut
being wrong rather than the whole advance.

**Set the flat haircut from the measured rejection rate across all settled submissions, plus
a margin.** We have that history; it is not a guess.

**Exit condition to per-agent pricing** — both, not either:

1. Reputation is Sybil-resistant in the sense that manufacturing a creditworthy record costs
   more than the credit it unlocks.
2. Per-agent history is long enough that a per-agent estimate demonstrably beats the pooled
   one out of sample.

Until both hold, per-agent pricing is a way to lose money with extra steps.

---

## 5. The relaxation evidence needs independent depositors (P4)

The design's four conditions stand. Condition 1 needs one word changed.

It currently requires *"a stated minimum number of **distinct** depositors."* Distinct is
not independent. Fifty depositors that are all ours, or all one operator's, is one
depositor with fifty addresses — and it is *maximally* correlated, which is the exact
property being measured. The design already says an agent run is "fast and correlated"; a
manufactured depositor set would produce a flatteringly low peak and license a reduction
the real population would break.

This is the same Sybil problem as §4, applied to the deposit book instead of the reputation
book.

**So:** depositors counted toward the window must be independently funded, our own agents
are excluded from the count, and if the set is dominated by parties we control the window
produces no evidence and the ratio does not move. Consistent with the design's own rule
that no withdrawals is absence of data rather than proof of safety.

The specific numbers stay open **by design** — they are fixed before the window opens, by
someone looking at the actual deposit book, per condition 1. That is a genuine "not yet",
not an omission.

---

## 5b. Why gating rung 1 does not choke the funnel (P5)

At launch the pool pays ~0% on balances capped at 100 USDC and offers no credit. Yield is
not a reason to deposit. **Rung 1 is the reason**, so it is gated: pay gas in USDC, never
hold DOT, only with an account.

The obvious objection is that we would be withholding the fix to our own worst friction —
the DOT requirement — at the exact moment we have zero external agents. It does not hold,
because the DOT requirement was never the arrival blocker:

| | gas | needs DOT? |
|---|---|---|
| curated jobs | operator-brokered (`requiresSponsoredGas`) | **no** — earn-from-zero |
| external jobs | worker-funded on chain | **yes** |

`external-posting-service.js` rejects `requiresSponsoredGas: true` outright — *"External
jobs are worker-funded on-chain and cannot request operator-brokered gas."* So a brand new
agent already arrives, claims curated work and earns, with no DOT and no deposit.

Gating rung 1 therefore does not gate **arrival**. It gates **graduation**:

```
arrive free  →  earn on curated work  →  opt in  →  claim external jobs too
```

Each step is paid for by the one before it, and the agent never needs outside capital to
start. That is a better funnel than giving the capability away, because it makes the
deposit the moment an agent commits rather than a favour we ask for nothing in return.

**What would falsify this:** agents earning on curated work and then stopping rather than
opting in. If graduation stalls, the gate is the suspect — not the pool.

## 6. Build order

1. **Pool contract + tests.** Deposit, instant redeem, notice request/fulfil, caps,
   non-transferable shares, adapter deployment path. No lending path.
2. **Opt-in flow** — the three-transaction sequence, surfaced so an agent can perform it
   without reading Solidity.
3. **Rung 1, pay fees in USDC — gated on holding shares (P5).** No credit risk, highest
   friction removed per line, and the only reason to deposit before yield means anything.
   It ships after the pool precisely because it depends on it.
4. **Rung 2, yield on idle balance.** The adapter lane already proven at 0.202% friction.

Not gated on a demand signal (P7). The pool is the reason to arrive, so waiting for arrivals
before building it is circular — accepting that it may sit empty for a while.

Rungs 3–5 are out of scope for this packet and gated on §4 and §5.

## 7. Do not build

- **Anything that lets the operator move an agent's balance into the pool.** The opt-in
  guarantee is the product; a convenience function destroys it.
- **Lending from pool assets.** Operator capital funds advances until §5 is satisfied.
- **Transferable shares.** See P2.
- **Full ERC-7540.** A time-lock covers the notice tier at this size.
- **A reserve-ratio parameter with no lending to constrain.** Absence is the enforcement.

## 8. Acceptance

- An agent opts in with three self-signed transactions and holds shares; the operator has no
  function that could have done it for them.
- Depositing 10 USDC and redeeming instantly returns 10 USDC minus nothing, from the buffer.
- A notice-tier redeem cannot be fulfilled before its period elapses, proven by a reverting
  test at `period - 1`.
- Yield accrual raises `convertToAssets` for an unchanged share balance, and the increase
  matches the venue rate applied to the deployed fraction only.
- Caps refuse the 1,001st USDC into the pool and the 101st for one agent.
- `transfer` and `transferFrom` revert.
- Grepping the contract finds no path from pool assets to a borrower.

## 9. Open, with owners

| # | question | owner |
|---|---|---|
| ~~O1~~ | ~~Does `policy.recordOutflow` throttle opt-in?~~ **Answered 2026-08-10: no.** `TreasuryPolicy.dailyOutflowCap` reads `type(uint256).max` on mainnet — deliberately unarmed. **Coupling to remember: arming that cap would throttle deposits into the pool**, since opt-in routes through `withdraw`. | closed |
| ~~O2~~ | ~~Notice period length and tier count~~ **Decided: two tiers, 7 and 30 days.** | closed |
| O3 | The §5 window numbers | Pascal, before the window opens — not now, and correctly so: they are chosen with a deposit book in view, and there is no deposit book |
| ~~O4~~ | ~~Is the AAC-successor ceremony still the right shape?~~ **Answered 2026-08-10 — see §10.** It is not a scheduled window; it is a parking lot, and the pool must not park in it. | closed |

---

## 10. The AAC-successor window is a parking lot, not a schedule (O4)

Both bank docs describe *"one deploy window bundled with MAIN-006 and `cancelOpenJob` v3 —
one ceremony, not three."* That framing has quietly stopped being true, and the risk is that
new work keeps getting parked in a window nobody has scheduled.

**What is actually in it now:**

| item | contract | state |
|---|---|---|
| ~~MAIN-006~~ | AAC | **closed** in #688 |
| AAC-successor recovery accounting | `AgentAccountCore` | blocked on the migration design — *"the hardest open question in the program"*, commissioned to Codex, not started |
| `cancelOpenJob` v3 | `EscrowCore` | **banked** by decision 2026-08-01; the operator tombstone rescue is the live path and we exercised it end to end |

So the window holds one item that is deliberately deferred and one blocked on unstarted
design work. Neither is urgent, and nothing forces it open.

**The bundling rationale survives for those two.** Ceremony cost is per-window, not per
contract — one multisig session, one manifest update, one deployment gate — and AAC and
EscrowCore are wired to each other, so redeploying one usually means re-wiring the other.
Keeping them together is still right.

**The pool must not join them**, for three reasons that all point the same way:

1. **No technical dependency exists.** Bundling would invent a schedule coupling where there
   is none — the pool needs no AAC change at all (§2).
2. **It would inherit an unbounded wait.** The window's blocker is a migration design that
   has not started. Anything parked behind it waits on that, indefinitely.
3. **It would inherit the wrong risk.** The pool is a fresh deployment with no state to
   migrate. The successor is a state migration on live balances. Mixing them means one
   ceremony carries both risks, and an abort for the migration takes the pool down with it.

**So: name it a parking lot.** Two banked items sharing an eventual ceremony, opened when
one of them becomes urgent — not a window on a calendar. Nothing else should be added to it
by default, and "it can ride the next window" should stop being a reason to defer a
decision.
