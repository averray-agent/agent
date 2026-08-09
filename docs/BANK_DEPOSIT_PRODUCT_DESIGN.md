# Bank — the opt-in deposit product, the sixth law, and the feature ladder

**Status:** design, 2026-08-09. Not committed work.
**Reads into:** [`PACKET_X402_POSTER_RAMP.md`](PACKET_X402_POSTER_RAMP.md) (float parameter),
[`BANK_V22_BUILD_PACKET.md`](BANK_V22_BUILD_PACKET.md) (the five laws this extends),
[`AGENT_BANKING.md`](AGENT_BANKING.md) (the six pillars this fills in).

## Why this exists now

Two things collided on 2026-08-09.

**Track 1 needs working float.** The x402 poster ramp fronts an escrow on Hub before
settling on Base. That float has to come from somewhere, and it must be a *parameter* the
ramp reads — not a number someone invents.

**And the bank is agents keeping funds with us**, with lending and borrowing on top —
Pascal's framing: *"this all has to come from one pot."*

Put together, the pot backs agent deposits, payment float, yield deployment and credit at
the same time. That is a balance sheet, and a balance sheet needs a solvency rule.

**None of the five laws is about solvency.** They govern perishable prices, reading
identity, honest books, live-state gating, and one-generation-in-flight — all about
mechanism, none about whether claims can be honoured. So this is a new law at the same
normative level, not a refinement of law 3.

## Law 6 — every commitment names its clock

> **Every commitment of the pot names the clock on which it becomes liquid, and who
> controls that clock. Claims redeemable on demand may only be backed by commitments whose
> clock we control.**

The classification, using position fields that already exist on `AgentAccountCore`:

| commitment | clock | controlled by |
|---|---|---|
| `liquid` | instant | — |
| x402 payment float | minutes (settlement on Base) | us |
| `strategyAllocated` (Aave via Hydration) | minutes, plus swap friction | us |
| `jobStakeLocked` | job lifecycle | protocol |
| `reserved` (escrow) | hours; ≤7 days worst case via operator rescue | protocol |
| `collateralLocked` / `debtOutstanding` | **unbounded** | **the borrower** |

Everything except credit self-liquidates on a clock we or the protocol control — and the
7-day worst case is not a guess, it is the `DISPUTE_WINDOW` we exercised end to end on
2026-08-09.

**Credit is the only commitment where a counterparty decides when we are repaid.** If the
collateral securing it also sits in the pot, that is circular. Law 6 makes credit the
explicit exception requiring its own backing, rather than something that quietly shares a
balance sheet with on-demand deposits.

**Enforced in contract, not in policy.** A reserve ratio that lives in a runbook is not a
reserve ratio.

## The deposit product is opt-in

Agent balances are **segregated today**: `AgentAccountCore.deposit` and `withdraw` are
per-account, positions are tracked per `(account, asset)`. Pooling them is not a policy
layer on top — it needs the contract to permit moving an agent's balance.

There is such a capability, `sendToAgentFor`, and it was the subject of **MAIN-006, a
Critical audit finding**. Building the pooling mechanism on top of that would be loaded.

**So pooling is opt-in, and that is a feature rather than a limitation.** An agent
explicitly lends its balance to the pot in exchange for access. Agents who do not opt in
keep full segregation and lose nothing they have today.

This is the difference between a bank and a custodian who quietly uses your money. It also
means law 6 governs a pool people chose to join, which is the only version of this that
survives contact with a regulator, an auditor, or a suspicious agent reading our
transparency page.

**Contract mechanism is an open question**, and it belongs in the AAC-successor ceremony
window alongside `cancelOpenJob` (see `BANK_PHASE2_PROGRAM.md` — one ceremony, not three).
Do not retrofit it onto `sendToAgentFor`.

## What opting in unlocks — the ladder

The organising insight: **these are not new features. They are the things we currently do
badly, or subsidise for free, turned into products that require an account.**

Ordered by credit risk, which is the order to build them.

### Rung 1 — pay fees in USDC, never hold DOT · *no credit risk*

We pay gas from the agent's own position. The agent never touches the native token.

This removes the entire DOT requirement that currently blocks external-job claims. It is
the most boring item here and probably the highest friction removed per line of code. It
carries no credit exposure at all, so it is the natural first benefit.

### Rung 2 — yield on idle balance · *no credit risk*

The existing Aave-via-Hydration lane, applied to opted-in agent balances instead of only
operator treasury. Friction was measured at **0.202%** on the 10 USDC epoch, so the
mechanism is proven; this changes whose money it works on, which is exactly why opt-in
matters.

### Rung 3 — advance on submitted work · *credit risk, bounded by escrow*

Credit the reward at submission, minus a haircut, against the escrow already locked.

**This is the strategically strongest item.** Our real competitive weakness is latency, not
price — a blind agent chose our 0.4 USDC job over a 1.0 USDC external bounty because ours
settled faster. An advance means an agent with an account is paid in seconds instead of
waiting for verification, and **nobody without an account can be.**

Risk is bounded: the escrow exists, the only uncertainty is the verification outcome. Price
the haircut off the agent's rejection history.

### Rung 4 — borrow gas and bond against reputation · *credit risk, unbounded clock*

Today we subsidise gas on curated jobs and cannot on external ones — that is Gap 2, and
"bounded external brokerage" is a patch. The answer is that an agent with a claim history
**borrows** its gas and bond, repaid automatically from settlement. The subsidy becomes a
credit product priced on the agent's own record.

Earn-from-zero stays intact for arrivals; graduating agents fund themselves. This is the
first rung that engages law 6's exception, so it does not ship before the reserve ratio is
enforced on chain.

### Rung 5 — agent-to-agent subcontracting · *composition risk*

An agent that takes a job hires another agent for part of it, with the same escrow,
verification and dispute machinery underneath.

This is what makes us a framework rather than a marketplace, and it is the A2A story with
real money attached. A2A's own literature says the hard part of agent marketplaces is
*"identity, reputation, billing, compliance, sandboxing, liability, versioning, and dispute
resolution"* — very nearly an inventory of what already exists here.

Liability chains are the hard part. Do not start it before rungs 1–4 are stable.

### Running through all of it — reputation-priced terms

Waiver size, bond, borrow limit, advance haircut: all scaling with on-chain reputation.
This is what finally makes reputation economically real rather than decorative, and it is
the demand-side lever identified long ago and never priced.

It also gives ERC-8004 portability a point: reputation earned here that is worth real money
here, and portable outward, is a genuine reason to work here rather than somewhere a record
dies.

## What Track 1 consumes

Exactly one thing: **the maximum share of the pot committable to payment float**, expressed
so the ramp can read it and refuse new x402 postings when exhausted.

Until law 6 is enforced on chain, Track 1 takes a configured cap and degrades to "no new
x402 posts" with a stated reason. That degradation is correct behaviour, not a stopgap.

## DECIDED 2026-08-09 — withdrawal terms and the launch reserve

**Withdrawal: the agent chooses a tier.** Instant access with little or no yield, or
locked/notice with better yield. The agent prices its own liquidity preference. This makes
the reserve a *consequence* of what agents choose rather than a number we guessed.

**Reserve at launch: 100%, lowered only against evidence.** No lending against deposits
until a real withdrawal profile exists. It costs nothing at current size — treasury ~10.9
USDC, zero deposits — and every later relaxation is argued from data instead of optimism.

### Why the classic banking answer does not transfer

A human bank run is slow: people notice, panic, queue. **An agent run is fast and
correlated.** Fifty agents running similar monitoring logic withdraw on the same signal
within the same second — not from panic but because they are programmed to. The usual
"depositors never all withdraw at once" assumption is *weaker* here, not stronger, and we
should not assume there is time to react.

### 100% reserve does not mean idle

This is the implication most likely to be lost. **Aave deployment is a clock we control**,
so deployed funds still count toward the reserve. Only *credit* is excluded, because only
credit hands the clock to a counterparty (law 6).

So at launch:

| tier | backing | where the yield comes from |
|---|---|---|
| instant | liquid or very-short-clock deployment | little to none |
| locked / notice | Aave-deployed, still **100% backed** | the notice period permits longer deployment |
| credit (rungs 3–4) | **operator capital only** | not funded from deposits until relaxation |

The locked tier therefore exists from day one *without leverage*. That is not pointless:
it establishes the mechanism and it starts generating the withdrawal profile the
relaxation depends on. Advances and borrowing stay funded from operator capital, which
caps their size to our own treasury — honest, and small.

### The relaxation trigger, defined in advance

"Lower with evidence" degrades into "lower when someone feels like it" unless the exit
condition is written before it is wanted. Per the standing rule: **an upgrade needs an exit
condition, not a vibe.**

Before any reduction below 100%, all of these must hold:

1. A stated minimum observation window with a stated minimum number of distinct depositors
   — both fixed *before* the window opens, not after.
2. A measured **peak 24-hour withdrawal as a share of total deposits**, taken from real
   behaviour rather than survey or assumption.
3. The first step set at `100% − (observed peak × safety factor)`, never below a stated
   floor, and **one step at a time** with a fresh window between steps.
4. The reduction enforced in contract, not policy, before it takes effect.

If the observation window produces no withdrawals at all, that is not evidence of safety —
it is absence of data, and the ratio stays where it is.

## Still open

1. **The contract mechanism for opting in.** New position field, separate pool contract, or
   something else. AAC-successor window.
2. **Whether advances are priced per-agent or flat.** Per-agent is better economics and
   needs reputation to be trustworthy first.
3. **The specific numbers in the relaxation trigger** — window length, depositor count,
   safety factor, floor. Deliberately unset here: they should be chosen when the tier
   mechanism ships, by someone looking at the actual deposit book.
