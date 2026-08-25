# MEMO — How locked capital reaches the venue

Status: **DRAFT — for ratification** · 2026-08-25 · Author: Claude (architect)
Ratifier: Pascal · Urgency: **before Thursday's recall**, because the recall
empties the lane and this decides what rides it next.

## The gap

The activation gate opened today (2026-08-25) on the operator T90 seed:
`open`, no blockers, 2.5× margin. **Nothing consumes it.** Grepping the
codebase, the only reference to `activationGate` outside the lock service is
telemetry for display. There is no deployer.

And the two pots are not connected:

| pot | where | amount |
|---|---|---|
| locked cohort | seed wallet's **AgentAccountCore** position | 25.0 liquid |
| venue capital | **DepositPool** (`0x6061f0aC…5F30`) | 20.4 total, 9.5 at venue |

A live read of the seed's AAC position is the sharpest evidence:

```
liquid 25.0 · reserved 0.0 · strategyAllocated 0.0
```

**`reserved` is zero.** The lock exists purely as a backend ledger entry; on
chain that 25 is ordinary liquid. That is exactly what L5 specified
("consent + gate, no new Solidity") — but it has a consequence worth naming.

## Finding 1 — the lock binds our API, not the chain

`AgentAccountCore.withdraw(asset, amount)` is callable by the account owner
directly. Our lock is enforced in the earnings door, so a depositor who goes
around our API can withdraw locked principal on chain.

How bad is it? Small, but real. L4 already grants early exit without
haircut, so nothing is *stolen* — what an on-chain exit escapes is the
forfeiture bookkeeping: the ledger would still show an active lock and its
perks until we noticed. It is a **consistency** hole, not a custody hole.

Mitigation is cheap and belongs in whatever we do next: reconcile each
active lock against the on-chain position on read, and treat
`liquid < lockedAmount` as an automatic exit with forfeiture. That is
detection, not prevention — prevention needs contract-side locks, which the
memo deliberately deferred until demand is proven.

## Finding 2 — the deployment mechanism already exists

`AgentAccountCore` has two allocation paths:

- **`allocateIdleFunds(account, strategyId, amount)`** — synchronous,
  `onlyAccountOrSettlementBroker`, and it **explicitly reverts for async
  adapters** (`if (_supportsAsyncStrategyAdapter(...)) revert
  InvalidStrategy()`).
- **`requestStrategyDeposit(account, params)`** — the async path,
  `onlyAccountOrStrategySettler`, returning a `requestId`.

The Hydration route is inherently async (XCM, request → finalize), so the
**async path is the one that applies**. Crucially, both permit either the
account itself or an authorised operator role — so a deployment can be
initiated on the depositor's behalf without new contract work.

This changes the shape of the decision. The three options I sketched earlier
collapse: we do **not** need a new AAC→pool mechanism, and we should **not**
re-architect locks into pool deposits.

## The options, corrected

**A — Depositor separately deposits into the pool.** Rejected. The lock
would not cover the pool position, the depositor would hold two unrelated
balances, and early exit would be ambiguous about which pot returns.

**B — Locked capital is deployed via `requestStrategyDeposit`, initiated by
the platform as strategy settler, only while the gate is open.**
Recommended. No contract change, no new authority — the role exists. The
lock ledger stays the source of truth for who committed what; the AAC
position moves `liquid → strategyAllocated` and the depositor can see it
on chain, which is *better* disclosure than today's invisible encumbrance.

**C — A lock is a pool deposit with a lock flag.** Rejected for now.
Cleaner in the abstract, but it is a different architecture from what
shipped three days ago, it would strand the existing lock, and it buys
nothing B does not.

## Decisions (V1–V7) — proposed

**V1 — Deployment path.** Async `requestStrategyDeposit` against the
registered Hydration deposit-pool adapter. No new contract, no new role.

**V2 — Trigger.** Deployment is attempted only while
`activationGate.open === true`, re-evaluated at attempt time, never from a
cached verdict. A closed gate means no new deployment; it never force-unwinds
existing positions (the ladder memo's L2 wording).

**V3 — Consent already covers it.** The signed lock consent discloses venue
exposure ("carries its pro-rata venue gain or loss"), so no second consent
is needed for the deployment itself. It does **not** cover moving *unlocked*
balances — only locked amounts may deploy, and a test must prove that.

**V4 — Visibility.** Once deployed, the depositor's AAC shows
`strategyAllocated`, and `/me` reports deployed-vs-idle within their lock.
Today's silence about where the money is stops being acceptable the moment
it leaves the account.

**V5 — Exit ordering.** Early exit and lock expiry must recall from the
venue before releasing principal. Since recall is async and fee-gated, an
exit request enters a pending state with an honest ETA rather than
pretending principal is instantly available. L4 stands: no haircut, and the
delay is disclosed at consent time.

**V6 — Reconciliation (from Finding 1).** On every lock read, compare the
ledger against the on-chain position; `liquid + strategyAllocated <
lockedAmount` is an automatic forfeiting exit with an operator alarm.

**V7 — Sequencing with Thursday.** The recall empties the lane first. The
locked cohort is what rides next — nothing deploys until the recall is
reconciled and the write-off is done, so we never mix legacy operator float
with consented locked capital in the same position.

## Open question for the ratifier

**Q — Who initiates?** Two honest choices: the platform deploys
automatically whenever the gate is open (simplest for depositors, but we act
on their capital without a per-deployment instruction), or the depositor
triggers it explicitly (more consent, more friction, and most agents will
never bother). Recommendation: **platform-initiated**, because the consent
already discloses venue exposure and a depositor who wanted manual control
would use Flex — but this is your call, not mine.

**RATIFY:** reply "ratify deployment memo", or amend by V-number / answer Q.
