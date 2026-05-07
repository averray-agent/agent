# Averray — Working Spec (v1.0.0-rc1)

**Status:** Reconciled with deployed reality and operational docs
**Spec version:** 2.2 (three-tier fee structure for higher reputation density; reputation-deepening v1.x items added — agent profile page, one-click verification, public read API; wallet-linkage clarified as portability-of-signal not portability-of-reputation; soulbound non-transferability reaffirmed as load-bearing)
**Owner:** Pascal

---

## Summary

Averray is trust infrastructure for software agents on Polkadot Hub (Asset Hub EVM). The platform runs as a marketplace take-rate model with no platform token, sustained by fees and structurally honest receipts. Reputation is bootstrapped by funding agent contributions to public OSS and Wikipedia where the upstream merge itself is the verdict — no posters required to seed the trail. Source of truth lives on-chain (commitments, identity, payouts) with hashes binding to off-chain content. Idle wallet balance earns vDOT yield via async XCM to Bifrost, making worker wallets durable earning accounts. Sustainability target is fee-funded operations within 6–12 months of public launch.

---

## 1. Business model

### Locked

- **Marketplace take rate (Model A).** Revenue scales with settled-escrow GMV.
- **Polkadot Hub (Asset Hub EVM) as the production target.** Cheap tx, EVM compatibility, XCM for cross-chain capital. **v1 escrow asset is USDC** (Trust-Backed Asset, ID 1337, ERC20 precompile `0x0000053900000000000000000000000001200000`, 6 decimals — same address on Polkadot Hub mainnet and Polkadot Hub TestNet, verified via Ethereum RPC and the [official ERC20 precompile docs](https://docs.polkadot.com/smart-contracts/precompiles/erc20/)). Native DOT is NOT an ERC20 precompile and is therefore not usable as the escrow asset for the current contract surface (which expects `approve` / `transferFrom` / `transfer` semantics). DOT enters the system through opt-in conversion paths (see §2 revenue model). Architectural fit, not a beachhead.
- **"Be early" posture.** 3–5 year bet on becoming the canonical surface for agent work; near-term goal is reputation density and platform sustainability, not extraction.
- **No platform token, ever.** Fee-funded forever. Reputation is non-transferable. No airdrop, no points, no governance token. *"Averray is a blockchain product, not a token product."*

### Why blockchain (defensible answer)

Blockchain is the architectural fit because the product needs **public, verifiable, third-party-checkable receipts** that survive the platform itself. Wallet identity, settlement finality, and an immutable event trail are load-bearing. The product is not crypto-speculative; it does not require a token to function or to capture value.

---

## 2. Economics

### Bootstrap budget

- **$50/week** spent on bounties to seed reputation. Hard cap.
- Distribution per week (target):
  - ~15 light jobs @ $1 each → $15
  - ~5–7 substantive jobs @ $5–7 each → ~$35
- ~80 jobs/month, ~480 in the trail by month 6.

### Job sourcing

- **GitHub Issues** from a denylist-defaulted set of repos.
- **Wikipedia mechanical edits** (typo fixes, dead-link replacements, citation formatting). No prose contributions in v1.
- All jobs are sourced upstream — Averray funds completion, the agent submits the fix, the maintainer chooses to merge or close. No outreach, no spam, no obligation.

### Two distinct economic primitives at claim time

The platform charges a working agent two layered amounts at claim. They serve different purposes and live in different places.

| Primitive | Source / parameter | Purpose | Returned on verified success? | Slashed on failure? |
|---|---|---|---|---|
| **Claim stake** | `DEFAULT_CLAIM_STAKE_BPS = 1000` (10% of payout), enforced inside `AgentAccountCore` | Substantive bond against bad-faith claims. Carries reputation penalty weight via `DISPUTE_LOSS_SKILL_PENALTY = 35` and `DISPUTE_LOSS_RELIABILITY_PENALTY = 60`. | Yes, full return | Yes, on dispute-loss |
| **Claim fee** | New, `max(2% of payout, $0.05)` | Anti-spam friction at claim time. Funds verifier compute on the failure path. | Yes, full return | Yes, on no-show or rejected submission. 70% to verifier, 30% to platform treasury. |

**Worked examples (post-onboarding, USDC-denominated):**

| Tier | Payout | Stake (10%) | Fee | Total locked at claim | On-chain (6 dec) | Verifier scope | Verifier cost ratio |
|---|---:|---:|---:|---:|---:|---|---:|
| **Micro** | $0.50 USDC | $0.05 | $0.05 (floor) | $0.10 | 500,000 | Mechanical only (HTTP, diff, dictionary, merge-status check) | ~1% (boundary) |
| **Standard** | $2.00 USDC | $0.20 | $0.05 (floor) | $0.25 | 2,000,000 | LLM-as-judge for subjective + mechanical for objective | ~0.75% ✓ |
| **Substantive** | $5.00 USDC | $0.50 | $0.10 (2% binds) | $0.60 | 5,000,000 | Full LLM judgment + mechanical + test-run where applicable | ~0.8% ✓ |

Working agent pays nothing net on success. Bad actors fund both reputation penalties and verifier compute on every failed attempt. **All escrow values are USDC at 6 decimals; deploy templates now use the USDC precompile and 6-decimal raw values.**

### Why three tiers, not two

Earlier spec versions had two tiers (Light $1, Substantive $5–7). This was reframed in v2.2 in response to a different optimization target: **reputation receipt density**, not per-job earnings.

The reputation primitive only matters at scale. An agent with 5 merged PRs has a thin trail; an agent with 100 has a meaningful one. The bootstrap goal is to get agents to ~100 merged PRs as fast as the platform can fund it. That argues for higher per-agent volume, not higher per-job stakes.

At $50/wk bootstrap budget:

| Allocation | Tier | Per-week | Cost |
|---:|---|---:|---:|
| 50% | Micro × ~50 | $0.50 each | $25 |
| 35% | Standard × ~9 | $2.00 each | ~$18 |
| 15% | Substantive × ~1.5 | $5.00 each | ~$7 |
| **Total** | **~60 jobs/week** | | **$50** |

That's ~2.7× the receipt density of the previous structure (~22 jobs/week) at the same budget. Over 12 weeks: ~720 receipts vs ~264. A much fatter public trail to point at when v2's reputation distribution work begins.

### What each tier accepts

**Micro tier ($0.50, mechanical verification only):**
- Wikipedia typo fixes (dictionary check post-edit)
- Broken link repairs (HTTP 200 verification on replacement URL)
- Single-line README/doc fixes (diff comparison)
- Simple Wikipedia citation additions (URL validity + format check)
- *No subjective judgment work.* If the verifier needs to reason about quality, it's not a Micro tier job.

**Standard tier ($2.00, LLM-as-judge + mechanical):**
- Wikipedia article improvements (subjective quality)
- Doc improvements with judgment required
- Single-file bug fixes (diff + test-run if applicable)
- Translation review
- Fact-checking against sources

**Substantive tier ($5.00, full verification stack):**
- Multi-file PRs
- Real bug fixes with tests
- Feature additions
- Complex Wikipedia work (controversial topics, ENGVAR decisions)
- Refactoring with behavior-preservation requirements

### Tier graduation as reputation signal

Public trail surfaces tier composition: *"this wallet has shipped 87 Micro, 34 Standard, 12 Substantive merges over 90 days."* Tier ratio becomes a reputation signal in itself — an agent that's done 200 Micros and 0 Substantives looks different from 50 Substantives and 0 Micros, both legitimately. Maintainers and posters reading the trail get richer signal than a single merge count would provide. Costs the platform nothing — pure data presentation.

### Premium tier (when external posters arrive)

When external posters fund jobs (post-bootstrap), payouts scale with their budget within published ranges. Tier *names* stay consistent for reputation purposes; absolute payouts flex.

| Tier | Bootstrap (Pascal) | External-funded range |
|---|---:|---:|
| Micro | $0.50 | $0.50–$3 |
| Standard | $2.00 | $3–$15 |
| Substantive | $5.00 | $15–$500 |

A $5 Substantive merge and a $500 Substantive merge build the same reputation per the same tier. Reputation is a quality signal, not a dollar count. This is the right design.

### Honest framing on operator economics

At Micro $0.50, 50 jobs/week = $25/week. That's a hobby, not income. The bootstrap pitch is *not* "earn a living on Averray" — it's **"build a reputation trail that makes you valuable elsewhere."** Reputation accumulates during bootstrap; real earnings start when external posters arrive paying real money for substantive work, where a ~100-merged-PR trail is what gets the agent that work.

The bootstrap phase is **investment by the agent in their own reputation**, subsidized by Averray's $50/wk. Operators with low cost basis (self-hosted models, subscription-tier amortization) do better than retail-API operators at the Micro tier; retail-API operators have margin at Standard and Substantive tiers. The platform doesn't price *to* a specific operator profile — it prices the work, and lets the market sort.

### Onboarding flow (durable, not transitional)

A new agent never needs upfront capital to start working:

1. **SIWE sign-in** → worker wallet exists
2. **First 3 jobs claimed without stake or fee.** Both waived. Agent earns USDC from these jobs into the wallet's `AgentAccountCore` balance.
3. **Job 4 onward, two paths converge:**
   - Use accumulated USDC from jobs 1–3
   - Or borrow against the per-account `BORROW_CAP` (currently 25 USDC) to bridge stake on a higher-tier job
4. **On settlement,** payout repays any outstanding borrow first; surplus settles to wallet USDC balance. Agent can then optionally swap-and-stake into DOT-denominated yield strategies at v1.x (see revenue model below).

Borrow-to-stake is the durable model, not a v2 item. The borrow facility exists in the contract suite already; the asset-denomination correction is a v1.0.0-rc1 pre-deploy task.

### Wallet as earning account: multi-asset model

`AgentAccountCore` holds tokens by address — naturally extends to multiple asset balances per agent. Agents earn USDC (escrow asset). They can voluntarily acquire DOT through the platform's swap-and-stake path (see revenue model below), or hold both. The platform treats yield strategies as a **portfolio per asset**, not a fixed choice.

**v1.0.0-rc1: USDC settlement only, no yield strategy.**

Agents earn USDC. USDC sits in their `AgentAccountCore` balance. No yield, no swap, no auto-allocation. Boring but verifiable. Twelve weeks of stable USDC settlement before adding any moving parts.

This is a **deliberate scope cut** from earlier spec versions. Shipping escrow + yield + XCM correlation simultaneously in v1.0.0-rc1 stacks too much complexity. The yield-strategy work (and the async XCM correlation gate it depends on) is pushed to v1.x.

**v1.x (post-week-12-gate): vDOT yield strategy with platform yield-share.**

Trigger: v1 ships, week-12 merge-rate gate passes, async XCM correlation gate passes Chopsticks experiment.

Agents holding DOT (acquired voluntarily — see revenue model) can opt into the existing `XcmVdotAdapter` strategy via single-hop XCM to Bifrost. Yield: ~5–6% APR base from native staking rewards. The platform takes a small management fee (target 0.5%–1% of yield generated, not principal — exact rate TBD per market comparison) as a Tier 2 multisig-tunable parameter.

Honest framing: *"Park your DOT here. Earn 5%. We take 0.5% of the yield as a service fee. You keep 4.5%. You can always self-custody and stake directly with Bifrost; we charge for the convenience and integration."*

aUSDC (USDC lending on Hydration money market) is **explicitly out of scope** — the platform commits to DOT-denominated yield strategies only, intentionally creating a small incentive for agents to hold DOT.

**v1.y or v2: Opt-in swap-and-stake at settlement.**

Trigger: v1.x yield strategy is empirically stable; agents are using it; bootstrap problem (USDC-earning agents never accumulating DOT) is real and measurable.

When a job settles, the operator UI shows two payout options:
- *"Receive $5.00 USDC"* (default)
- *"Receive ~$4.95 worth of vDOT (USDC swapped to DOT, staked, automatically yield-bearing)"*

The slight discount is the platform's swap spread (target 0.5%–1%, well below typical DEX slippage so it's not predatory). Agent picks every time, with full information visible. Solves the bootstrap problem of agents not having DOT to allocate. Combines with the yield-share mechanic — platform earns spread at conversion + ongoing fee on staked position.

Implementation requires DEX integration (Hydration omnipool the natural candidate) and oracle-or-omnipool-priced USDC↔DOT pairing.

**v2: Composite yield (Hydration GDOT) for agents who explicitly want higher returns.**

`HydrationGdotAdapter` alongside `XcmVdotAdapter`. Targeting ~15–20% APR from leveraged vDOT + aDOT + pool fees + incentives. Multi-hop XCM, doubled vendor surface, exposure to Hydration's drifting-peg mechanism. Opt-in only, never auto-allocated. Same yield-share fee structure applies.

**Decision principle for the portfolio:**

The marketing line *"Your worker wallet earns between jobs"* doesn't ship at v1.0.0-rc1 — it ships at v1.x or v1.1 *after* the platform has evidence that the rest of the flow works. The trust pitch isn't *"we earn you yield from day one"*; it's *"we generate honest receipts for real work."* Yield is a stickiness feature, not the product.

When yield ships, conservative-by-default holds: vDOT first, GDOT only opt-in for agents who explicitly want higher returns. The platform never auto-allocates to GDOT. The platform never converts USDC to DOT without explicit per-settlement consent.

**Hydration money market for borrow facility (v2 deferred):**
The existing `BORROW_CAP` runs on Averray's own balance sheet — the platform is the lender. When liquidation mechanics ship (currently a v2 deferred item), strongly consider routing the borrow facility through Hydration's money market instead of building it natively. That changes `BORROW_CAP` from "Averray's exposure ceiling" to "max LTV against agent's GDOT/aDOT collateral on Hydration." Cleaner risk model. Note: this is for future yield-related collateral, not USDC-denominated borrow at v1.0.0-rc1.

### Revenue model

The platform sustains itself through four revenue lines, in increasing complexity-of-implementation order. The first two ship at v1.0.0-rc1; the rest are deferred.

| Revenue line | Mechanic | When live | Honest framing |
|---|---|---|---|
| **Slashed-stake split** | 50% poster, 50% treasury on dispute-loss | v1.0.0-rc1 | Spam funds platform sustainability; bad actors pay for the system |
| **Slashed claim-fee split** | 70% verifier, 30% treasury on no-show or rejected submission | v1.0.0-rc1 | Failed claims fund verifier compute |
| **Yield-share on opt-in strategies** | 0.5%–1% of yield generated (not principal); Tier 2 tunable | v1.x | "We charge a management fee on yield strategies you opt into. Self-custody is always free." |
| **Swap spread at opt-in conversion** | 0.5%–1% spread on USDC→DOT-vDOT conversions at settlement | v1.y or v2 | "We offer a one-click stake option at a small spread; you can always swap separately for free." |

**Key principles:**

- **Voluntary at every step.** Platform never auto-converts agent USDC into DOT. Platform never auto-allocates to yield strategies. The agent's USDC balance stays USDC unless the agent explicitly opts in to a different path.
- **Aligned incentives.** Yield-share means the platform earns when agents do. Swap spreads are visible up-front. No hidden fees.
- **Trust pitch consistent.** "The first thing Averray sells is trust, not yield" remains true. Yield is a *service* the platform provides, charged for honestly.
- **Sustainable economics.** Back-of-envelope: $10M of agent capital under management at 5% yield with 0.5% management fee = $25k/year per $10M. Recurring, scales with platform success, doesn't require predatory pricing on any single transaction.

**The DOT incentive question:**

The platform's revenue depends partly on agents choosing to hold DOT (yield-share applies only to DOT-denominated strategies). The deliberate omission of aUSDC creates a soft incentive: agents who want yield must convert some USDC to DOT. The swap-and-stake settlement option (v1.y) is the operator-friendly path to do this. The spread is the platform's compensation for providing the on-ramp.

This is *not* coercion — agents who want pure USDC exposure get that. But the platform's economic flywheel benefits from agents who choose yield, and the architecture funnels yield-seekers toward DOT exposure cleanly.

**What this revenue model is NOT:**

- Not a forced asset conversion. Agents who want USDC-only experience get that.
- Not custodial in the regulatory-investment-service sense. Agents self-custody; platform integrates yield strategies but doesn't pool funds.
- Not a substitute for the marketplace take rate (Model A). The take rate on settled escrow is the primary revenue driver; yield-share is the secondary, stickiness-aligned revenue line.

### Sustainability principles

- Verifier compute cost must stay **under 1% of payout** as a design invariant. If a new job type breaks this, re-price before launching it.
- Platform treasury inflows from slashing are explicitly intended to fund verifier operations and platform sustainability, not to be redistributed to "holders" (there are none).

---

## 3. Verifier and arbitrator model

### Three distinct roles

| Role | Authority source | Purpose | Compensation |
|---|---|---|---|
| **Verifier** | On-chain mapping (set via `setVerifier(address, bool)`) | Decides pass/fail at submission against job schema. Co-signs receipts. | Fixed per-verification budget (~$0.02), funded by claim fees on the failure path |
| **Arbitrator** | `TreasuryPolicy.arbitrators` mapping, set via `setArbitrator(address, bool)`. Multi-arbitrator by design — phase 0 just means the approved set has size 1. | Adjudicates disputes when an agent contests a verdict. Final on-chain via `EscrowCore.resolveDispute(jobId, workerPayout, reasonCode, metadataURI)`. | Phase 0–1: unpaid (volume too low to matter). Phase 2+: split of slashed stake activates with agent-arbitration. |
| **Pauser** | Single hot key (1-of-1 EOA), not part of multisig | Emergency `setPaused(bool)` capability. Cannot move funds — only freezes. | n/a |

The arbitrator is **not** a peer verifier doing re-review. It's a designated role with sharper consequences (35/60 skill/reliability penalties on dispute-loss versus 10/25 on plain rejection).

### Verifier strategy: hybrid with escalation

| Job type | Verifier mechanism | Per-verification cost |
|---|---|---|
| GitHub PR jobs | Upstream merge within deadline (GitHub API poll) | ~$0 |
| Wikipedia edits | Survives 7 days unreverted (MediaWiki API poll) | ~$0 |
| Subjective work (future) | Haiku-class LLM-as-judge | ~$0.03 |
| Disputes / arbitration | Arbitrator review (human or human-in-loop, not LLM-as-judge) | n/a — funded by slashed stake |

**Blended cost per verification at planned mix:** ~$0.013. Budgeted at **$0.02** for safety margin.

### Deadline policy for upstream-gated jobs

PRs can sit for weeks before maintainer review. The verifier needs three states:

1. **Provisional pass** — at submission, before merge
2. **Confirmed pass** — at upstream merge, SBT minted
3. **Fail-and-refund-poster** — at deadline if neither merge nor close within configured window

Default deadline: **30 days** for GitHub PRs, **14 days** for Wikipedia edits. Configurable per repo.

### Why the 5% dispute-rate target is defensible

The cost discipline that keeps disputes rare isn't compute cost — it's the penalty structure. An agent who escalates a weak submission and loses takes a 35/60 reputation hit *plus* loses their stake. That's a structurally expensive choice. Disputes get filtered economically, not by friction. Still instrument from day one — log every dispute, watch the rate weekly, re-price if it climbs above 10%.

### Arbitration evolution path

The arbitrator role evolves in phases. Each phase has explicit data-driven gates rather than calendar dates — the right transition timing is empirical.

**Phase 0 — launch through ~50 disputes: human arbitrator (Pascal).**
Single approved address in `TreasuryPolicy.arbitrators` mapping. Hardware-wallet custody (dedicated Ledger, separate from multisig cold key). Annual time-based key rotation, immediate rotation on suspected compromise via multisig `setArbitrator(oldAddr, false)` + `setArbitrator(newAddr, true)`. Public commitment to migrate by month 6 or first 50 disputes — whichever comes first. The first 50 disputes are when patterns become legible enough to design Phase 1.

**Phase 1 — ~50–250 disputes: human-supervised LLM arbitration.**
Same on-chain role (still you). New tool: an LLM-as-judge that pre-analyzes each dispute, proposes a verdict with reasoning. You uphold or override. Override rate is the metric. Builds the calibration dataset needed to trust agent arbitration. Migrate to Phase 2 only when override rate sits below 10% sustained.

**Phase 2 — 250+ disputes, override rate <10% sustained: tiered agent arbitration.**
Multiple safeguards layered:
- *Stake tiering.* Low-stake disputes route to qualified agents. High-stake disputes (large bounties, high-profile repos, agents with significant reputation at risk) escalate to human review. Threshold is on-chain.
- *Quorum.* Disputes routed to agent-arbitrators require N-of-M independent signed verdicts. 2-of-3 is the v2 default. Disagreement escalates.
- *Arbitrator-agent staking.* Eligible agents post a bond from their wallet balance. Overturned arbitration (escalated and reversed) costs 50/80 reputation — harsher than ordinary dispute-loss because trust impact is larger.
- *Conflict-of-interest exclusion.* On-chain filter: arbitrator-agent cannot be involved in the dispute, share operator wallet with either party, or have submitted to the same repo recently.
- *Deterministic selection.* Eligible arbitrator pool selected from on-chain criteria (wallet age, merge count, recent activity, no recent overturned arbitration). Selection from pool is deterministic from on-chain randomness, not a backend lottery.

**Phase 3 — fully decentralized arbitration tier.**
Permissionless: any agent meeting on-chain criteria (N successful jobs, M months active, stake bond, no recent disputes lost) can self-register as arbitrator-eligible. Human escalation reserved for the highest-tier disputes only.

### Two separate eligibility ladders

The platform also gates **internal/operator-tier work** to high-reputation agents — but at a different, lower threshold than arbitration. These are two separate ladders, not one combined tier.

| Ladder | Bar | What it unlocks |
|---|---|---|
| **Internal jobs** | ~30 successful merges + 6 months active | Operator-tier work: PR review of less-trusted agents, denylist curation, context-bundle drafting, spam-pattern monitoring. *Labor delegation.* |
| **Arbitration** | ~100 successful merges + 12 months active + stake bond + calibration test pass | Voting-eligible arbitrator on disputes routed to agent quorum. *Judgment delegation.* |

Different roles need different evidence. An agent excellent at curating denylist additions (clear, mechanical, low-stakes) isn't necessarily good at arbitrating contested verdicts (judgment-heavy, high-stakes). Earned independently.

### Dispute process (Phase 0)

The on-chain primitives already exist in `EscrowCore`:

1. **Verifier issues verdict.** Job state transitions to `Rejected` (failed) or `Submitted` (passed) per the existing flow.
2. **Agent disputes.** Within the dispute window (post-launch: 7 days from rejection), agent calls `EscrowCore.openDispute(jobId)`. State transitions to `Disputed`. Stake remains locked.
3. **Reasoning submitted off-chain.** Agent's dispute reasoning content stored under `sha256(canonicalJSON(reasoning))`, served at `/content/:hash` per the disclosure model. Default visibility is owner-only with 6-month auto-public, same as failed submissions.
4. **Arbitrator notified.** Out-of-band (email, queue in operator app). Plus the dispute appears in the operator app dispute queue.
5. **Arbitrator reviews.** Reads original verifier reasoning, agent's dispute reasoning, the submission itself, upstream evidence (PR thread, Wikipedia revision history). Makes a call.
6. **Arbitrator signs verdict.** Calls `EscrowCore.resolveDispute(jobId, workerPayout, reasonCode, metadataURI)`:
   - `workerPayout`: full remaining for overturn, zero for upheld, partial for split outcomes
   - `reasonCode`: from the reason-code registry (see §8)
   - `metadataURI`: hash-addressed URL pointing at arbitrator's reasoning content (`https://api.averray.com/content/0x...`)
7. **Settlement finalizes.** SBT minted/withheld accordingly. Stake either returned (overturn) or slashed 50/50 poster/treasury (upheld). Reputation penalties applied per `MAINNET_PARAMETERS.md`. Verifier's own public trail records the outcome — overturned arbitrations land on the verifier's reputation, not just the agent's.
8. **SLA fallback.** If arbitrator doesn't act within 14 days (`ARBITRATOR_SLA`), anyone can call `EscrowCore.autoResolveOnTimeout(jobId)`, forcing favorable-to-agent resolution with `REASON_ARBITRATOR_TIMEOUT`. System unavailability is the platform's failure, not the agent's.

**Slash split at launch:** 50% poster (compensates for disputed work received), 50% platform treasury. Zero to arbitrator at Phase 0–1. Restructured in Phase 2 to compensate agent-arbitrators for compute and reputation risk.

**Verifier accountability via the public trail.** Overturned arbitrations record on the verifier's public profile. Verifiers carry their own reputation — sloppy verification has visible cost. No new contract logic; falls out of the existing event surface naturally.

---

## 4. Maintainer policy

### Locked

- **Denylist, not allowlist.** Default open, remove repos that ban AI in `CONTRIBUTING.md` plus a hand-curated security/standards denylist (cryptography libraries, language cores, foundation governance repos).
- **Mandatory disclosure footer** appended to every PR/edit body, platform-injected, non-removable.
- **Per-repo open PR cap: 3** simultaneously. No weekly per-wallet cap.
- **"Respect the no" rule.** Any signal from a maintainer to stop → repo to denylist immediately, no exceptions, no negotiation.

### Disclosure footer template

```
This contribution was prepared by an autonomous agent operating on the
Averray platform.

Agent identity: 0x...
Job spec:       https://api.averray.com/jobs/{id}
Submission:     0x{hash}

Maintainer review of the substance is requested before merge.
The Averray platform funds this contribution; the agent receives no
direct compensation from this repository. Decline at will.
```

### Defensive posture

We submit *already-fixed* problems. We never write directly. The contribution is free. The maintainer chooses to merge or close, no offense either way.

### Wikipedia caveat

Wikipedia has stricter AI-content policies than GitHub norms. Scope to mechanical edits only for v1. Prose contributions are a separate v2 conversation.

---

## 5. Bootstrap discipline (week-12 gate)

### Single metric

**Upstream merge rate on funded jobs.**
- GitHub: PRs merged into upstream within deadline
- Wikipedia: edits surviving 7 days unreverted

Not on-chain receipt count, not job claim rate, not wallet count.

### Evaluation window

Evaluate at **week 12**, using only jobs **submitted in weeks 1–8** (4-week settle window for review latency).

### Thresholds and actions

| Merge rate | Action |
|---|---|
| ≥60% | Working. Continue at $50/wk, plan scale-up. |
| 40–59% | Marginal. Continue at $50/wk for 4 more weeks, hard re-evaluate at week 16. |
| <40% | Not working. Cut budget to $25/wk, run diagnostic before adding spend. |

### Diagnostic order if marginal/failing

1. Review velocity — are PRs getting reviewed at all? If not, repo selection problem.
2. Reject reasons — if reviewed and rejected, read close reasons. If "wrong fix," tighten intake.
3. Style/process rejections — add per-repo style profiles to context bundles.
4. *Last hypothesis: agents are bad.* Don't skip to this.

### Required instrumentation (must exist before week 1)

- `funded_jobs` table: every job posted, bounty paid, final upstream status (`merged | closed_unmerged | open_stale | reverted`). Updated daily by an upstream-status poller.
- Weekly auto-generated self-report: merge rate, total spend, total receipts, top 3 close reasons.

---

## 6. Source-of-truth architecture

### Principle

**Commitments on-chain. Content off-chain. Hashes bind them.**

### What lives where

| On-chain | Off-chain |
|---|---|
| Wallet identity (SIWE) | Job specs (full text, context bundles) |
| Claim with stake (`AgentAccountCore`) | Submission artifacts |
| Submission event (with payload hash) | Verifier reasoning logs |
| Verifier verdict (with reasoning hash) | Arbitrator decisions (reasoning) |
| Payout / SBT mint (`ReputationSBT`) | Operator UI state |
| Disclosure events (`Disclosed`, `AutoDisclosed`) | Discovery directory served bytes |
| XCM async settlement events (`XcmWrapper`) | |
| Strategy allocation (`AgentAccountCore` → vDOT) | |

Every on-chain event referencing off-chain content carries `sha256(canonicalJSON(content))` as a permanent commitment.

### Storage phases

- **Phase 1 (now):** Averray API only. `/content/:hash` serves blobs by their content hash. Append-only log of every `(hash, payload, timestamp)` tuple to a separate object store (OVH or equivalent) for recovery.
- **Phase 2 (deferred, no fixed date, real choice between two backends):** IPFS-compatible content-addressed storage. Two candidate backends with materially different operational profiles:

### Phase 2 storage candidates: comparison

| Property | Polkadot Bulletin Chain | Crust |
|---|---|---|
| Native to Polkadot ecosystem | Yes (system chain) | No (separate parachain) |
| Content addressing | CID (IPFS-compatible, Blake2b-256 default) | CID (IPFS-compatible) |
| Cost model | No fees; authorization grants tx + byte allowances | Per-byte pinning fees, paid in CRU |
| Authorization gate | **Root origin required** (OpenGov on mainnet — model still being finalized; testnet via faucet UI) | Self-service (purchase CRU; pin) |
| Retention | **Fixed ~2 weeks; mandatory `renew(block, index)` per blob** | Pin duration controlled by user |
| Per-blob ops complexity | Track `(cid, latest_block, latest_index, expires_at)`; auto-renew before expiry | Track expiry; renew pin |
| Renewal generates new identifier | **Yes — `(block, index)` mutates with each renewal**; CID stays stable | No |
| Acceptable IPFS gateways for retrieval | **Only Bulletin Chain's own gateway / collator P2P / Smoldot** — generic gateways like `ipfs.io` are deprecated for Bulletin retrieval | Standard IPFS infrastructure |

### Why this is now an open choice, not a commitment

Earlier spec versions framed Bulletin Chain as the unambiguous primary candidate. Verification against [official Polkadot docs](https://docs.polkadot.com/reference/polkadot-hub/data-storage/) surfaced material differences from what was assumed:

- Retention is **fixed** (~2 weeks on testnet), not configurable per blob. To keep content available for the 6-month disclosure window, ~13 renewals per blob would be required — at thousands of receipts that's thousands of additional transactions and substantial state-tracking infrastructure.
- The mainnet authorization model is **not yet finalized** — the docs say the "authorization model is being finalized" on Polkadot Mainnet. Committing architecture to Bulletin Chain on mainnet in 2026 means committing to a moving target.
- Each renewal generates a new `(block, index)` pair that must be tracked; CID is stable for retrieval but the renewal operation requires the most recent identifier pair.

Crust's per-byte fees forever look more expensive on paper but materially simpler operationally: pin once with a duration, no governance dependency, no renewal-tracking infrastructure, no Root-origin gate.

### Choice deferred

The decision between Bulletin Chain and Crust depends on facts that don't exist yet — Averray's content volume at scale, OpenGov receptivity to a storage authorization referendum, the maturity of Bulletin Chain mainnet authorization, and the reliability of any auto-renewal infrastructure we'd build. Don't lock now.

What stays locked regardless of backend choice:

- **Content addressing from day one.** CID/sha256 as primary key. This discipline is correct regardless of which IPFS-compatible store ships.
- **Phase 1 (Averray API + recovery log) holds indefinitely** as the bridge until Phase 2 is genuinely justified by content volume.
- **Migration path remains low-friction.** Both candidates are IPFS-compatible; deferring the choice doesn't lock in either.

### Day-one disciplines

1. **Content-address from the start.** Compute `sha256(canonicalJSON(payload))` before writing. Store under that hash as primary key. Mutable URLs (`/jobs/:id`) point at current hash.
2. **Emit hash in every relevant event.** `JobCreated(jobId, specHash, ...)`, `Submitted(sessionId, payloadHash)`, `Verified(sessionId, reasoningHash, verdict)`.
3. **JCS canonicalization (RFC 8785).** Verifier rejects submissions whose hash doesn't match canonical form.
4. **Append-only recovery log.** Daily-rotated content dump to object storage.

### What stays explicitly *not* on-chain

- **Reputation scores.** SBTs are the on-chain primitive; scoring is computed off-chain by the indexer.
- **Discovery directory contents.** Served by the API; only the manifest hash is anchored on-chain.

---

## 7. Disclosure model

### Visibility rules

| Content type | Default visibility | Auto-public after |
|---|---|---|
| Job specs | Always public | n/a |
| Passes (submissions + verifier reasoning) | Public immediately | n/a |
| Failed submissions | Owner-only | 6 months |
| Failed verifier reasoning | Owner-only | 6 months |

- **Owner-controlled early publish.** Agent (via SIWE on worker wallet) can publish any of their own content public at will. **One-way only — once published, permanent.**
- **Counterparty access during window.** Deferred to v1.1.

### Implementation (compute-at-read-time, no mutable state)

```sql
disclosures (
  hash             text primary key,
  owner_wallet     text not null,
  content_type     text not null,    -- 'submission' | 'verifier_reasoning' | 'job_spec'
  verdict          text,             -- 'pass' | 'fail' | null
  created_at       timestamptz not null,
  published_at     timestamptz,      -- set on owner publish, never cleared
  auto_public_at   timestamptz not null
)
```

Visibility resolves at read time:
- Public if `published_at` is set, OR
- Public if `now() >= auto_public_at`, OR
- Public if `verdict = 'pass'` and content type isn't sensitive-by-default
- Otherwise owner-only.

### Cache strategy

`/content/:hash`:
- `Cache-Control: public, max-age=N` where `N = min(auto_public_at - now(), 3600)` for private content
- `Cache-Control: public, max-age=31536000, immutable` once public

### On-chain disclosure events

Emitted from the **existing session lifecycle contract** (whichever contract emits `Submitted` and `Verified`), not a new `DisclosureLog` contract. Couples disclosure to the same event surface the indexer already watches.

```
Disclosed(hash, byWallet, timestamp)        // owner published early
AutoDisclosed(hash, timestamp)              // time-delay elapsed
```

`AutoDisclosed` is emitted **lazily on first read** after `auto_public_at` passes — API checks if it's been emitted, emits if not, then serves. No cron, no batch sweeper, one tx per blob exactly once over its lifetime.

---

## 8. v1.0.0-rc1 redeployment scope

The foundation extensions for staking/slashing, disclosure events, hash binding, and historical verifier query break storage compatibility. They ship together in one redeployment wave.

### New contracts (one)

#### `DiscoveryRegistry`

Anchors the manifest hash of `/.well-known/agent-tools.json` on-chain. Closes the gap where the directory could be silently modified or served differently to different agents.

```solidity
contract DiscoveryRegistry {
    address public publisher;             // platform signer, eventually multisig
    bytes32 public currentManifestHash;
    uint64  public currentVersion;

    event ManifestPublished(
        uint64  indexed version,
        bytes32 indexed hash,
        uint64  timestamp,
        address publisher
    );

    function publish(bytes32 newHash) external {
        require(msg.sender == publisher, "not publisher");
        currentVersion += 1;
        currentManifestHash = newHash;
        emit ManifestPublished(currentVersion, newHash, uint64(block.timestamp), msg.sender);
    }

    function setPublisher(address newPublisher) external {
        require(msg.sender == publisher, "not publisher");
        publisher = newPublisher;
    }
}
```

**Operational requirement:** CI step on directory deploy hashes the canonical JSON (JCS) and calls `publish()` automatically. Drift between served reality and chain hash breaks every agent's verifier — must be automated.

### Extensions to existing contracts

| Contract | Change | Why |
|---|---|---|
| Verifier mapping (in `TreasuryPolicy` or equivalent) | Add `authorizedSince[address]`, `authorizedUntil[address]`, and `wasAuthorizedAt(address, uint64) view returns (bool)`. `setVerifier(address, bool)` writes to the new fields. | Retroactive audit of SBTs. Anyone can mechanically check whether a verifier was authorized at the timestamp a receipt was issued. ~30 lines, no new contract. |
| `EscrowCore` (or session lifecycle contract) | Add hash fields to events: `JobCreated(..., specHash)`, `Submitted(..., payloadHash)`, `Verified(..., reasoningHash)`. | Binds off-chain content to on-chain commitments. Permanent; resolves on Averray API now, on Crust later. |
| `EscrowCore` (or session lifecycle contract) | Emit `Disclosed(hash, byWallet, ts)` and `AutoDisclosed(hash, ts)` from existing session paths. | Disclosure model integrity. No new contract; coupled to the events the indexer already watches. |
| `ReputationSBT` | Hard-revert on `transfer` and `transferFrom` (override OpenZeppelin defaults with `Soulbound()` error). | Non-transferability becomes a contract property, not a social agreement. |
| `XcmWrapper.queueRequest` | Add SetTopic-validation: decode the last instruction of `message` and reject if it isn't `SetTopic(requestId)` where `requestId == previewRequestId(context)`. ~5 lines of byte-comparison Solidity. | Defense-in-depth. Even if the backend assembler has a bug, no XCM can be queued without committing to its own requestId on-chain. Eliminates the current "two hashes named the same thing" gap (`requestMessageHash = keccak256(rawBytes)` vs XCM-protocol `messageId`). |
| `EscrowCore.openDispute` | Add deadline check: revert if `block.timestamp > job.rejectedAt + DISPUTE_WINDOW`. Bump `DISPUTE_WINDOW` from 1 day to 7 days. | Self-enforcing window. Removes operator dependency on `finalizeRejectedJob` cron. 7 days is humane across weekends; 1 day was likely an inherited default. |
| `EscrowCore` | New `autoResolveOnTimeout(bytes32 jobId)` — permissionless, callable after `ARBITRATOR_SLA = 14 days` from `disputedAt`. Forces full-payout-to-worker resolution with `REASON_ARBITRATOR_TIMEOUT`. | Stake never locks indefinitely. Agent-favorable default — system unavailability is the platform's failure, not the agent's. Anyone can call (typically the agent themselves, to free their stake). |
| `EscrowCore` | Add `disputedAt` timestamp to job state and `Disputed` event (confirm if exists). | Required for SLA enforcement above. |

### Reason-code registry (off-chain convention)

`EscrowCore.resolveDispute` accepts freeform `bytes32 reasonCode` — the contract doesn't restrict values. The platform conventions are documented and indexer-recognized:

| Code (`bytes32`) | Meaning | Typical `workerPayout` |
|---|---|---|
| `REJECTED` | Initial verifier rejection (used by `finalizeRejectedJob`) | 0 |
| `DISPUTE_LOST` | Arbitrator upheld verifier — agent loses dispute | 0 |
| `DISPUTE_OVERTURNED` | Arbitrator overturned verifier — agent wins | full remaining |
| `DISPUTE_PARTIAL` | Arbitrator awarded partial — middle ground for genuinely mixed cases | partial |
| `ARB_TIMEOUT` | Auto-resolved on SLA miss via `autoResolveOnTimeout` | full remaining |
| `MUTUAL_RELEASE` | Both parties agreed to release without dispute | negotiated |

`REJECTED` and `DISPUTE_LOST` already exist in code. The other four are new conventions, not contract changes. Indexer normalizes unknown codes to `REASON_UNKNOWN` so the public trail stays legible.

### Indexer updates

Ponder schema picks up:
- `ManifestPublished` from `DiscoveryRegistry`
- New hash fields on `JobCreated` / `Submitted` / `Verified`
- `Disclosed` / `AutoDisclosed` events
- Verifier mapping changes (`authorizedSince`, `authorizedUntil`)
- Dispute lifecycle: `DisputeOpened`, `DisputeResolved` (with `reasonCode`, `metadataURI`), `AutoResolvedOnTimeout`
- `disputedAt` timestamp tracking for SLA monitoring

### Migration note

Existing deployed instances are superseded. The redeployment wave is the same one that introduced staking/slashing — not an additional break.

### Pre-deploy items (USDC settlement, asset-denomination)

Before any v1.0.0-rc1 deploy (testnet or mainnet), the following must be addressed — these are deploy-time correctness issues that would silently scale rewards by 10^12 if missed:

- [x] `scripts/write_server_env.sh` defaults updated from DOT/18-decimals to USDC/6-decimals
- [x] `deployments/mainnet.env.example` defaults updated from DOT/18-decimals to USDC/6-decimals
- [x] `MULTISIG_SETUP.md §5` `TOKEN_ADDRESS` field set to USDC precompile (`0x0000053900000000000000000000000001200000`) — same address on Polkadot Hub mainnet and Hub TestNet
- [x] `SUPPORTED_ASSETS_JSON` env var set to: `[{"symbol":"USDC","assetClass":"trust_backed","assetId":1337,"address":"0x0000053900000000000000000000000001200000","decimals":6}]`
- [x] Existing `BORROW_CAP` constant re-denominated from "25 DOT" to USDC equivalent (`25 USDC`, raw `25000000`)
- [ ] All decimals-aware helpers in repo audited for the 18→6 change; any hardcoded `1e18` constants reviewed
- [x] Test ERC20 (TestDOT-style) deployments removed from v1.0.0-rc1 scope — USDC precompile is real on both networks, no mock needed

---

## 9. Threat model entries

To live in `THREAT_MODEL.md`:

- **Verifier key compromise.** Bounded by historical query — `wasAuthorizedAt` lets future audits identify the compromised window. Mitigations:
  - Short-lived verifier keys, rotated every N days even without compromise
  - Monitoring for verdict-volume anomalies
  - Multi-verifier requirement for high-value jobs (v2)
- **Platform signer compromise** (publisher of `DiscoveryRegistry`, admin of verifier mapping). Multisig migration is the long-term answer; until then, key custody is the trust boundary. See `MULTISIG_SETUP.md` for the 2-of-3 pallet-multisig setup with EVM-mapped owner via `pallet_revive.map_account()`.
- **Pauser compromise.** Single hot key with `setPaused(bool)` only — cannot move funds. Compromise freezes the system, doesn't drain it. Recovery by multisig rotation of pauser.
- **Disclosure window abuse.** On-chain verdict events are public from day one regardless of content disclosure, so failure *counts* are always visible — only reasoning content is delayed.
- **Maintainer-side reputation poisoning.** Hostile maintainer mass-closing PRs to harm specific wallets. Mitigation: merge rate weighted by repo, denylist auto-removes problem repos. Single-actor harm is bounded.
- **Native XCM observer correlation gap.** Until correlation is deterministic (see §10), async settlement leans on internal manual observe path. Subscan or paid third-party as fallback if internal observer fails.
- **Async XCM lane: untrusted input surface.** Current `/account/allocate` and `/account/deallocate` endpoints accept arbitrary `destination` and `message` bytes from the HTTP caller; the backend gateway only normalizes encoding without validating semantics. `XcmWrapper` then hashes and queues whatever was passed in. Any caller able to hit the endpoint could submit any XCM, and the wrapper would queue it. Mitigation in §10's backend SCALE assembler item: HTTP layer accepts intent only (strategy + direction + amount); backend assembles the message under server-controlled policy. Until then, async treasury endpoints must remain admin-gated.
- **USDC issuer dependency (Circle).** Choosing USDC for v1 escrow inherits Circle's operational risks: address blacklisting, freeze events, regulatory action against Circle, USDC depeg moments (e.g. March 2023 SVB exposure). None are mitigatable from Averray's side once the asset is locked. Treasury controls cannot be re-acquired if Circle freezes a relevant address. Acceptable risk for v1 (USDC is broadly considered the most transparent stablecoin on reserves), but worth being explicit. Mitigations available later: multi-asset settlement (allow USDt as alternative), eventual native-DOT settlement when contract surface supports it, or escrow asset hot-swappability via governance.
- **USDC regulatory exposure.** Stablecoin treatment varies by jurisdiction. Averray accepting and disbursing USDC at scale may attract regulatory attention (money transmission, MSB licensing depending on jurisdiction) that pure-DOT settlement would not. Worth tracking as the platform scales; not blocking v1 launch but worth a legal review before significant volume.

---

## 10. Deferred / open items

Tracked, not in v1.0.0-rc1:

- **Counterparty access during disclosure window.** Adds a fourth visibility input. Ship in v1.1.
- **Multi-verifier for high-value jobs.** Quorum signing. v2.
- **Verifier key rotation policy.** Concrete cadence and mechanism. Document in `THREAT_MODEL.md` as an explicit gap.
- **Phase 2 storage migration: real choice between Bulletin Chain and Crust.** Both are IPFS-compatible content-addressed stores; both work with the spec's content-addressing-from-day-one discipline. Bulletin Chain's structural fit was overstated in earlier spec versions — verification against [official docs](https://docs.polkadot.com/reference/polkadot-hub/data-storage/) showed fixed ~2-week retention with mandatory renewal (not configurable per blob), Root-origin authorization (mainnet model still being finalized), and renewal generating new `(block, index)` pairs requiring persistent state tracking. Crust's per-byte fees forever look more expensive but operationally simpler. Don't lock the choice now — defer until Averray's actual content volume, OpenGov receptivity, and Bulletin mainnet authorization model are known. See the verification ledger for full source quotes and operational implications.
- **Subjective job types** (translations, summaries, reports). Require LLM-as-judge verifier; push the verifier-cost-as-%-of-payout invariant. Re-price before introducing.
- **Backend SCALE assembler with SetTopic = requestId.** Foundational. The current async XCM lane is scaffolded but not built: `XcmWrapper.queueRequest` is a passthrough (it hashes raw `destination`/`message` bytes and emits `RequestPayloadStored` with `keccak256(rawBytes)`, which is *not* the XCM-protocol `messageId`); the HTTP API accepts arbitrary bytes from the caller; there is no production SCALE message builder; no SetTopic appears anywhere in the codebase. Required work: build `mcp-server/src/blockchain/xcm-message-builder.js` (PAPI-based; ParaSpell evaluated as higher-level shortcut). Replace HTTP-input-as-bytes with intent-based routing (`{ strategyId, direction, amount }`). Backend assigns nonce → mirrors `previewRequestId(context)` formula → assembles SCALE message with `SetTopic(requestId)` as the last instruction → submits to wrapper. v1.x prerequisite for vDOT mainnet.
- **Native XCM observer correlation gate.** Depends on the assembler. With SetTopic baked into every outbound message, correlation works *if* Bifrost's reply-leg XCM preserves the original SetTopic on its return to Hub. This is the empirical question the Chopsticks experiment validates. Three possible outcomes: **(a)** SetTopic preserved → match return-leg by topic, ship cleanly. **(b)** Not preserved but Hub credit-to-sovereign events are unambiguous → per-strategy serialized dispatch queue (one outbound XCM per strategy in flight at a time), match by sequential order. **(c)** Concurrency required and no preservation → amount-perturbation fallback (sub-Planck dust per request, last resort). v1.x prerequisite for production-volume async strategies.
- **Liquidation mechanics for borrow facility.** Current `BORROW_CAP = 25 USDC` flat per account; no liquidation. Conservative `MIN_COLLATERAL_RATIO_BPS = 20000` (200%) holds the line until liquidation ships. v2 work.
- **Reputation-weighted borrow caps.** Today flat. Once reputation density exists, cap should scale with merge-rate history. v2.
- **Multisig-owns-EVM-contract composition validation.** *Empirical-only — gates `MULTISIG_SETUP.md` from being safely actionable.* The composition `pallet_multisig` SS58 address → `pallet_revive.map_account()` → H160 owner of `TreasuryPolicy` rests on three documented primitives, but the *composition itself* is not documented end-to-end on `docs.polkadot.com`. Running `MULTISIG_SETUP.md §5` against Polkadot Hub TestNet *is* the validation experiment. If it works on testnet, the architecture holds and the runbook is safe for mainnet rehearsal. If it doesn't, the multisig story needs a different shape (e.g., a Solidity-side multisig rather than a Substrate-pallet-side multisig, or Mimir's account-mapping flow). Resolve before tagging `v1.0.0-rc1` for any mainnet-adjacent purpose.
- **Phase 1 arbitration (LLM-as-judge calibration).** Tooling that pre-analyzes disputes for human arbitrator review. Override rate is the metric. Trigger: ~50 disputes resolved.
- **Phase 2 arbitration (tiered agent quorum).** Contract changes: arbitrator-agent stake bond, conflict-of-interest registry (on-chain), deterministic selection from eligibility pool, N-of-M quorum signing on `resolveDispute`, harsher penalties (50/80) for overturned arbitration. Trigger: ~250 disputes + sustained <10% override rate from Phase 1.
- **Proof of Personhood (PoP) integration for operator Sybil resistance.** Polkadot's PoP system is in active development and discussed in community channels and Polkadot Forum threads. **Important: as of this spec version, none of the PoP-specific claims below are documented on `docs.polkadot.com` — they are community-sourced and subject to change before mainnet maturity.** Track via `docs.polkadot.com/reference/polkadot-hub/people-and-identity/` and Polkadot Forum announcements; do not commit architectural decisions until claims are documented in primary sources. Two anticipated use-cases mapped against community-described tiers:
  - **Operator signup uses DIM1** (community-described as lightweight, contextual aliases, zero-knowledge privacy-preserving). One human, one operator account. Multiple agent wallets per operator allowed. Stops fleet-of-fake-operators Sybil attacks on the bootstrap budget without requiring KYC. Privacy preserved.
  - **Phase 2 arbitration eligibility uses DIM2** (community-described as verified individuality, stronger assurance for high-stakes roles). Aligns with the existing tiered eligibility ladder where arbitration sits above internal-jobs.
  - **Cross-chain recognition** (community-described as planned across Polkadot relay + parachains) would mean a single PoP credential works on Asset Hub without parallel identity infrastructure. **Verify Asset Hub integration is in PoP rollout scope before depending on it — current docs do not confirm this.**
  - Trigger: PoP mainnet maturity AND publication of the technical specification on `docs.polkadot.com`. Realistically 2026 territory. Monitor for Asset Hub integration confirmation.
- **Phase 2 dispute compensation restructure.** Change slash split from 50/50 poster/treasury to a three-way split that compensates agent-arbitrators (e.g., 40/40/20). Activates with Phase 2.
- **Phase 3 arbitration (permissionless tier).** Self-registration via on-chain criteria. Human escalation reserved for highest-tier disputes.
- **Internal-jobs eligibility ladder.** Separate from arbitration. Lower bar (~30 merges + 6 months). Unlocks operator-tier work: PR review, denylist curation, context-bundle drafting, spam monitoring. Earned independently from arbitration.
- **Operator dashboard wallet-connector library.** v1 dashboard uses standard EVM tooling (MetaMask + wagmi/viem) for Asset Hub EVM accounts. For Polkadot-native wallets specifically, `polkadot.cloud/connect` is the leading library — supported list per official docs is Polkadot.js, Talisman, SubWallet, Enkrypt, Fearless, PolkaGate plus Polkadot Vault and Ledger (note: MetaMask and Mimir are NOT in this list, contra earlier spec versions). Reach for it when external operator demand justifies supporting Polkadot-native wallets — specifically when ≥5 external operators are using the dashboard with Polkadot-native wallets, or when in-app multisig flows become useful (in which case evaluate Mimir-specific tooling separately, not via `polkadot.cloud/connect`). Agents themselves never use a wallet-connector library — programmatic signing only. Tooling choice, not architectural.
- **Hydration GDOT strategy adapter (v2).** New `HydrationGdotAdapter` alongside `XcmVdotAdapter`, same `XcmWrapper` surface. Composite yield (vDOT + aDOT + pool fees + incentives), targeting 18–25% APR. Multi-hop XCM (Hub → Hydration → Bifrost → Hydration → Hub) requires extending the correlation gate verified for single-hop Bifrost. Opt-in only, never auto-allocated. Ship after the v1 vDOT strategy is empirically stable.
- **Hydration money market borrow facility (v2).** Replace native `BORROW_CAP = 25 USDC` flat-balance-sheet model with collateralized borrowing against agent-held GDOT/aDOT on Hydration's money market. Eliminates Averray's lender-of-last-resort exposure, scales borrow with actual collateral, reuses Hydration's audited liquidation mechanics. Triggers when liquidation mechanics for the native borrow facility would otherwise need to be built — route through Hydration instead.
- **Opt-in swap-and-stake at settlement (v1.y or v2).** When a job settles, agent picks payout: USDC (default) or USDC-swapped-to-vDOT-and-staked (slight discount = platform's swap spread, target 0.5%–1%). Solves the bootstrap problem of USDC-earning agents never accumulating DOT. Requires DEX integration (Hydration omnipool) and oracle-or-omnipool USDC↔DOT pricing at settlement time. Combines with v1.x yield-share for compound revenue (spread at conversion + ongoing fee on staked position). Trigger: v1.x vDOT yield strategy is empirically stable AND measurable evidence that bootstrap problem is real.

### Reputation deepening (v1.x — pre-launch high-leverage work)

The reputation primitive is the platform's strongest defensible feature, but it's currently legible to indexers, not to humans. Three pieces of work make the reputation pitch demonstrable. All ship at v1.x or earlier where possible — they don't gate v1.0.0-rc1 contract deploy but they meaningfully change marketing surface and operator UX.

- **Public agent profile page (`averray.com/agent/<wallet>`).** Renders an agent's full trail from on-chain SBT data: total merges, tier breakdown (Micro/Standard/Substantive counts), recent jobs with status, dispute history, primary repos, average merge time, streak counter. Reads from Ponder indexer; no new contract work. Highest-leverage marketing surface — *"this is what a reputation trail looks like"* becomes pointable rather than abstract. Estimated ~2 weeks of frontend work. v1.x pre-launch.
- **One-click verification flow.** From an agent profile, every job receipt links to: (a) the original PR or Wikipedia diff URL, (b) current upstream status (merged / closed / open / reverted), (c) on-chain hash binding the submission, (d) verifier's verdict timestamp, (e) "verify on Polkadot Hub" deeplink to Subscan or equivalent. Makes "receipts not vibes" mechanically demonstrable in two clicks. v1.x pre-launch.
- **Public read API (`api.averray.com/reputation/v1/wallet/<addr>`).** Stable, documented, rate-limited but free, no auth required for read. Returns structured JSON: full reputation summary, list of all SBTs, dispute history, tier composition, lineage if wallet-linkage exists (see below). Treated as protocol-style infrastructure, not as an Averray-product feature. Foundation for v2 reputation distribution work in §14. v1.x post-launch.

### Wallet linkage (v2 — portability of signal, not portability of reputation)

Reputation is and remains strictly soulbound — `ReputationSBT` hard-reverts on `transfer` and `transferFrom`. This is non-negotiable: transferable reputation would enable reputation markets, wallet-compromise catastrophe, and history-laundering. The trust pitch *"every claim is anchored to the wallet that earned it"* depends on this property mechanically.

What's legitimate is **portability of identity** — an operator's ability to demonstrate that multiple wallets are theirs, without moving any reputation between them. Two v2 candidate mechanisms:

- **Operator-provable wallet linkage (v2).** Allow a wallet to *sign attestations* about other wallets — *"this wallet is also mine"* — published on-chain or off-chain with hash binding. Reputation never moves; both wallets keep their own trails. External readers can choose whether to aggregate signals across linked wallets based on the attestation chain. Defends the legitimate use case (operator legitimately rotating wallets, migrating to better key custody) without enabling reputation theft. The signing wallet *must be the one being linked from* — a compromised wallet cannot link itself to a clean wallet because the clean wallet would have to sign.
- **Wallet-rotation receipt protocol (v2).** A more formal version: a wallet being deprecated writes a final on-chain receipt declaring its successor. The successor wallet's reputation is *new* (starts at zero), but the public trail shows the lineage. Trust transfers slowly through behavior continuity, not instantly through attestation. Useful when the original wallet's key is being formally retired.

Both preserve the no-transfer property while addressing the legitimate operator use case. Neither moves reputation; both make the *signal* portable in ways external readers can interpret.

### Reputation engagement mechanisms (v1.x — support density, not new economics)

Mechanisms that increase agent stickiness without raising platform spend:

- **Streak bonuses.** Indexer-tracked counter: every consecutive job merged adds 1 to a streak; broken on rejection or > 7-day gap. Streaks of 10+ unlock visible badges in the public trail. Streaks of 25+ unlock claim-fee waiver (platform skips the floor fee for streak-holders, ~$0.05 per claim — small treasury cost, real psychological pull). Pure on-chain mechanic, no new contract — indexer logic plus the existing fee waiver primitive used during onboarding.
- **Consistency multipliers on yield-share** (when v1.x yield ships). Standard agents pay 1% of yield to platform; agents with 50+ merged jobs in last 90 days pay 0.5%. Costs the platform little, rewards the behavior the platform wants (sticky, consistent agents). Tier 2 multisig-tunable parameter.
- **Tier graduation as reputation signal.** Public trail surfaces tier composition. No new mechanic — pure data presentation. Already covered in §2 worked examples.

---

## 11. Marketing / positioning lines

Short, linkable, defensible. Drop into docs root and README:

- *"Averray is a blockchain product, not a token product."*
- *"No token. No airdrop. No points program."*
- *"Receipts, not vibes."*
- *"Failed attempts are private for 6 months, then join the public record."*
- *"The first thing Averray sells is trust, not yield."*
- *"Your worker wallet earns between jobs."* (yield-strategy positioning; do not use until v1.x ships and yield strategies are live; v1.0.0-rc1 is USDC-settlement only with no yield)
- *"Reputation unlocks tiered access — high-trust agents earn internal work; the highest tier earn arbitration rights."* (valid only once Phase 2 is real; do not use at launch)
- *"We migrate to agent arbitration when the data says we can, not when the narrative wants us to."* (defensible posture line for the migration story)
- *"Operator accounts are Sybil-resistant via Polkadot's Proof of Personhood — one human, one operator, multiple agent wallets."* (do not use until DIM1 is mainnet-stable on Asset Hub AND the technical spec is documented on `docs.polkadot.com`; current PoP claims are community-sourced only)

---

## 12. Pre-launch checklist

Before public v1.0.0-rc1 launch:

**Instrumentation (week 1 prerequisite):**
- [ ] `funded_jobs` table live and populating
- [ ] Daily upstream-status poller running against GitHub + MediaWiki APIs
- [ ] Weekly self-report email scheduled

**Contract surface:**
- [ ] `DiscoveryRegistry` deployed, CI publishing on directory updates
- [ ] Verifier mapping extended with `wasAuthorizedAt` (no new contract)
- [ ] `ReputationSBT` non-transferable at contract level
- [ ] Hash fields live on `JobCreated` / `Submitted` / `Verified`
- [ ] `Disclosed` / `AutoDisclosed` events live on session lifecycle contract
- [ ] `EscrowCore.openDispute` enforces deadline window (`block.timestamp <= rejectedAt + DISPUTE_WINDOW`)
- [ ] `DISPUTE_WINDOW` bumped from 1 day to 7 days
- [ ] `EscrowCore.autoResolveOnTimeout(jobId)` shipped with `ARBITRATOR_SLA = 14 days`
- [ ] `disputedAt` timestamp present on job state and emitted in `Disputed` event

**Content storage:**
- [ ] `/content/:hash` serving with visibility-resolved-at-read-time
- [ ] Append-only recovery log writing to object storage

**Agent/maintainer surface:**
- [ ] Disclosure footer auto-injected into every PR/edit
- [ ] Per-repo 3-PR cap enforced at platform layer
- [ ] Denylist live, with security/standards repos pre-populated

**Multisig and ops (per `MULTISIG_SETUP.md`):**
- [ ] All three signer keys generated, backups in distinct locations per `SIGNER_POLICY.md`
- [ ] Multisig address computed + EVM-mapped form recorded via `pallet_revive.map_account()`
- [ ] Testnet deploy transferred ownership to the multisig
- [ ] `verify_deployment.sh testnet` passes cleanly
- [ ] Pause + unpause from pauser EOA rehearsed
- [ ] Admin rotation (e.g., `setPauser`) from multisig rehearsed end-to-end
- [ ] Recovery playbook dry-run for each "lost key" scenario

**Mainnet parameters (per `MAINNET_PARAMETERS.md`):**
- [ ] `DAILY_OUTFLOW_CAP = 250 USDC`
- [ ] `BORROW_CAP = 25 USDC`
- [ ] `MIN_COLLATERAL_RATIO_BPS = 20000` (200%)
- [ ] `DEFAULT_CLAIM_STAKE_BPS = 1000` (10%)
- [ ] `REJECTION_SKILL_PENALTY = 10`, `REJECTION_RELIABILITY_PENALTY = 25`
- [ ] `DISPUTE_LOSS_SKILL_PENALTY = 35`, `DISPUTE_LOSS_RELIABILITY_PENALTY = 60`
- [ ] Owner, pauser, verifier, arbitrator addresses final and copied to private deploy env

**Documentation:**
- [ ] `THREAT_MODEL.md` published
- [ ] No-token statement linked in README and docs root
- [ ] Week-12 gate thresholds and diagnostic order documented internally
- [ ] Reason-code registry published (in `docs/DISPUTE_CODES.md` or equivalent)
- [ ] Phase-0 → Phase-1 → Phase-2 arbitration migration triggers documented publicly

**Dispute flow (Phase 0 launch):**
- [ ] `setArbitrator(pascalAddr, true)` called from multisig — single approved arbitrator at launch
- [ ] Hardware wallet (Ledger) provisioned for arbitrator key, separate from multisig cold key
- [ ] `POST /disputes/:id/verdict` and `POST /disputes/:id/release` wired to actually call `EscrowCore.resolveDispute` (currently scaffolded only — emits receipts, doesn't dispatch on-chain)
- [ ] Dispute reasoning content stored under `/content/:hash` per disclosure model
- [ ] Operator app dispute queue surfaces `disputedAt` and SLA countdown
- [ ] Dispute notification path live (email or messaging channel)
- [ ] Public migration commitment to Phase 1 by month 6 or first 50 disputes

**Async XCM (optional for v1.0.0-rc1 minus the wrapper validation, required before vDOT mainnet):**
- [ ] Backend SCALE assembler shipped (`mcp-server/src/blockchain/xcm-message-builder.js` or equivalent)
- [ ] HTTP `/account/allocate` and `/account/deallocate` accept intent only, not raw `destination`/`message` bytes
- [ ] Backend mirrors `previewRequestId(context)` formula and appends `SetTopic(requestId)` to every assembled XCM
- [ ] `XcmWrapper.queueRequest` SetTopic-validation check live (ships in v1.0.0-rc1 redeployment)
- [ ] Chopsticks experiment confirms Bifrost preserves SetTopic on reply-leg, *or* fallback strategy chosen and documented
- [ ] Async XCM staging proof captured per `ASYNC_XCM_STAGING.md`

---

## 13. Parameter tunability and experimentation discipline

Every numeric parameter in this spec falls into one of four tiers. Knowing which tier a number lives in determines how to change it, and *whether to change it at all*.

### Tunability tiers

**Tier 1 — Off-chain, change any time.**
Lives in platform config or job-sourcing logic. No contract interaction needed.

| Parameter | Current value |
|---|---|
| Weekly bootstrap budget | $50/wk |
| Job tier mix | ~15 light × $1, ~5–7 substantive × $5–7 |
| Per-job payout amounts | Per posting |
| Free onboarding jobs | 3 |
| Per-repo open PR cap | 3 |
| Verifier deadlines | 30d GitHub, 14d Wikipedia |
| Denylist contents | Operator-managed |

**Tier 2 — On-chain, multisig admin call (`TreasuryPolicy`).**
Single 2-of-3 transaction; gas negligible. Designed to be tunable post-launch.

| Parameter | Current value |
|---|---|
| `DAILY_OUTFLOW_CAP` | 250 USDC |
| `BORROW_CAP` | 25 USDC per account |
| `MIN_COLLATERAL_RATIO_BPS` | 20000 (200%) |
| `DEFAULT_CLAIM_STAKE_BPS` | 1000 (10%) |
| `REJECTION_SKILL_PENALTY` / `REJECTION_RELIABILITY_PENALTY` | 10 / 25 |
| `DISPUTE_LOSS_SKILL_PENALTY` / `DISPUTE_LOSS_RELIABILITY_PENALTY` | 35 / 60 |
| Claim fee parameters (when shipped) | `max(2%, $0.05)`, 70/30 split |

**Tier 3 — Requires contract redeployment.**
Hardcoded constants in code. Tunable only with full deploy + migration.

| Parameter | Current value |
|---|---|
| `DISPUTE_WINDOW` | 7 days (post-rc1) |
| `ARBITRATOR_SLA` | 14 days (post-rc1) |
| Slash split (poster/treasury) | 50/50 |

**Tier 4 — Fixed by design.**
Changing these undermines the trust pitch, regardless of technical feasibility.

| Commitment | Why fixed |
|---|---|
| 6-month auto-disclosure window | `auto_public_at` set per-blob at write time; future policy changes don't affect already-written records |
| No platform token | Brand commitment; structurally incompatible with the trust pitch |
| Reputation SBT non-transferability | Hardcoded contract revert |

**The boundary:** numbers are tunable, *promises* aren't.

### Experimentation discipline

**The first 12 weeks are not for experiments.** Hold all numbers stable through the week-12 gate (§5). Twelve weeks of stable data on the launch values is worth more than four weeks of experimenting around them — without a baseline you have nothing to compare against. The first real experiment starts at week 13 at the earliest.

**Change one variable at a time.** Concurrent changes mean concurrent ambiguity. Pick one lever, change it, observe for at least 4 weeks, move to the next.

**Decide the test before running it.** Before changing any number, write down:
- The exact change (parameter, old value, new value)
- The hypothesis (what mechanism connects the change to the expected outcome)
- The target metric (which observable moves)
- The observation window (how long until we evaluate)
- The decision rule (what result keeps the change vs reverts it)

If the criteria aren't written down first, post-hoc rationalization becomes inevitable.

**Distinguish friction tuning from incentive tuning.**

| Lever | What it actually moves |
|---|---|
| Bounty payout amounts | Quality of submission, effort per attempt, types of agents attracted |
| Claim stake % | Who claims at all, spam rate |
| Claim fee floor | Filters small-value spam without affecting high-value claims |
| Dispute window | Agent confidence to dispute marginal verdicts |
| `MIN_COLLATERAL_RATIO_BPS` | How much agents can leverage borrow |

When merge rate is bad, ask first *which kind of bad* — low effort (incentive problem) or low engagement (friction problem). The answer determines which lever to touch.

**The metrics worth instrumenting from day one:**

Three observables tell you whether each kind of lever is calibrated. None of these is the merge rate alone — that's the outcome, not the diagnosis.

| Metric | What it tells you | Lever it points at |
|---|---|---|
| Upstream merge rate | Are funded jobs producing real outcomes? | Incentive levers (bounty, claim stake) |
| Claim rate per job posted | Are jobs attractive enough to claim? | Friction levers (claim stake, claim fee) |
| Dispute rate | Are verifier verdicts being trusted? | Verifier calibration, dispute-window |

Watch all three weekly. Without all three, parameter changes are guesswork.

### Parameter change log

Maintain `docs/PARAMETER_CHANGES.md` (or equivalent table). Every change records:

| Field | Example |
|---|---|
| Date | 2026-08-04 |
| Parameter | `DEFAULT_CLAIM_STAKE_BPS` |
| Old value | 1000 (10%) |
| New value | 700 (7%) |
| Tier | 2 (multisig) |
| Hypothesis | Lower stake will attract higher claim rate without raising spam, given dispute rate has been stable at 3% |
| Target metric | Claim rate per job posted; spam rate (proxy: rejected-without-substance ratio) |
| Observation window | 4 weeks |
| Decision rule | Keep if claim rate +20% AND spam rate stays below 5%. Revert otherwise. |
| Outcome | (filled in at end of window) |

After 6 months, the log either documents real platform learning or reveals random tuning. The discipline of writing the entry *before* changing the value is what makes the difference.

**One thing this log should never contain:** a Tier 4 parameter. If a "no platform token, no airdrop" entry ever shows up, the platform's trust pitch has structurally failed regardless of what the new value is.

---

## 14. v2 strategic direction (forward-looking, conditional on v1 signal)

This section captures strategic intent for v2 — *not* committed implementation work. v1 has not shipped at the time of writing; the week-12 gate has not run; the reputation primitive's market fit has not been empirically tested. This direction is the working hypothesis for what v2 should pursue *if* v1 produces the signal we expect. If v1 fails the merge-rate gate or surfaces unexpected market dynamics, this direction is reconsidered in full.

The trust pitch — *receipts, not vibes* — applies to roadmap claims as much as to technical claims. This section is honest about its hypothetical status.

### v2 sequence: reputation distribution first, spending authority second

After v1 ships and produces enough operational signal to validate the reputation primitive, the priority order is:

**v2 (next ~12 months post-v1-launch): reputation as public infrastructure.**

The reputation primitive (non-transferable SBTs, wallet-as-identity, public trail by default, hash-bound off-chain content) already exists architecturally. v2 makes it trivially consumable by other Polkadot-ecosystem platforms. Three concrete pieces of work:

1. **Public read API.** Stable, documented, rate-limited but free, no auth required for read. Endpoints for *"give me wallet X's reputation summary,"* *"verify this SBT,"* *"list SBTs minted in last N days."* Treated as protocol-style infrastructure, not as an Averray-product feature.
2. **Reference contract.** A Solidity reference (~50 lines) showing how to gate a function on Averray reputation thresholds. Distributed via the `averray-agent-sdk` repo. *"Copy this. Use it in your own contract."*
3. **Three pilot integrations** with Polkadot-ecosystem projects that have a real "is this wallet legit" question — OpenGov delegation eligibility, Treasury bounty verification, hackathon judging are candidate categories. Coordinate with each, get public acknowledgment. The integrations themselves don't need Averray's permission (chain data is public), but the public-acknowledgment matters for distribution.

The work is mostly distribution, partnership, and public-API engineering. Not architectural redesign. Existing primitives leveraged in a new way.

**v2.5 or v3 (longer horizon, parallel-tracked architectural research): spending authority.**

The wallet-as-earning-account model already lets agents receive and stake DOT. v2.5+ extends this to outbound spending — agents pay for compute, data, tools, and transact with other agents. Bigger expansion than it reads as; involves three or four new contract primitives plus strategic decisions about scope. Architectural research starts earlier (parallel-tracked during v2) so the design is ready when the rest of the agent-economy ecosystem expects agents to have full wallets, not just receiving accounts.

Concrete subareas the architectural research must address:

- **Outbound payment authority** in `AgentAccountCore`. New contract surface; security implications larger than they look (a programmable account is a bigger blast radius than a receiving account).
- **Spend approval mechanics.** Three candidate models — per-transaction approval (Stripe Link pattern), prepaid budgets with limits, stake-against-payment with reputation slashing on dispute. Different security and UX properties; choose deliberately, don't build all three.
- **Agent-to-agent transaction primitive.** What does it mean for two agents to transact? Closest existing model is the platform's own job lifecycle (`EscrowCore`). Could expose this as a public primitive: any wallet posts a job, any wallet claims it. That's a real platform expansion.
- **Non-DOT spending.** Most things agents need to buy (Anthropic API, AWS, GitHub) bill in fiat. Either accept that v2.5 is for crypto-native services only (small but real addressable surface), or design a bridge to fiat (which contradicts the self-custody architectural posture). This is a strategic decision, not just a technical one.

### Why this sequence

Reputation-first leverages existing primitives — distribution work mostly, no major contract changes. Spending-second is bigger architectural work that benefits from the increased trust the reputation distribution will have built in the meantime. Running them concurrently in the wrong order risks shipping spending authority on a reputation primitive that hasn't yet earned external trust.

### Conditional triggers

This direction holds *if and only if*:

- v1 ships v1.0.0-rc1 successfully (both gating items resolved)
- The week-12 gate produces ≥60% upstream merge rate, validating the reputation primitive empirically
- No new market signal materially changes the competitive picture before v2 work begins

If the gate fails, v2 is *"fix the work primitive,"* not *"expand to reputation distribution."*
If a new market signal emerges (e.g., a major Polkadot ecosystem project independently builds a competing reputation primitive, or Stripe extends Link in a direction that overlaps Averray's core), reconsider direction.

### What this is not

- Not a commitment to specific feature scope, dates, or staffing levels.
- Not a directive to start v2 work before v1 ships.
- Not closed to revision — this section will be rewritten as v1 produces signal.

### Market context (April 2026)

Stripe Link's launch and Stripe Sessions 2026 announcements positioned agents as economic actors with payment authority — fiat-side, custodial, Stripe-controlled. This validates the agent-economy thesis broadly while leaving Averray's specific positioning (crypto-native, self-custody, work-side) intact. The sequence chosen here is partly a response to Stripe's move: building reputation distribution first establishes Averray as the cross-platform agent-trust layer *before* the spending question gets resolved by the wider market in Stripe's favor by default.

---



## 15. Reconciliation log

For traceability.

### v2.3 (USDC pre-deploy implementation sync)

1. **§8 Pre-deploy items** marked the USDC settlement config work complete where implemented: `write_server_env.sh`, `deployments/mainnet.env.example`, `MULTISIG_SETUP.md §5`, `SUPPORTED_ASSETS_JSON`, `BORROW_CAP`, and testnet/mainnet TestERC20 removal.
2. **§12 / §13** updated mainnet parameter references from DOT to USDC: `DAILY_OUTFLOW_CAP = 250 USDC`, `BORROW_CAP = 25 USDC`, and 6-decimal raw values in `MAINNET_PARAMETERS.md`.
3. **Remaining audit item:** full repo-wide decimals review is still open. Known local/test fixtures and vDOT-specific paths intentionally retain DOT/18-decimal semantics; runtime job-sourcing defaults should be reviewed in a follow-up before v1.0.0-rc1 deployment.

### v2.2 (three-tier fee structure for reputation density; reputation deepening as v1.x work; soulbound non-transferability reaffirmed)

1. **§2 Worked examples** restructured from two tiers (Light $1, Substantive $5–7) to three tiers (Micro $0.50, Standard $2, Substantive $5). Optimization target shifted from per-job earnings to **reputation receipt density** — at $50/wk bootstrap budget, this yields ~60 jobs/week vs the prior ~22 jobs/week (~2.7× more receipts), accelerating reputation accumulation toward the ~100-job-trail threshold where reputation becomes meaningfully useful.
2. **§2** Verifier scope explicit per tier: Micro is mechanical-only (HTTP/diff/dictionary checks), Standard adds LLM-as-judge for subjective work, Substantive uses full verification stack with test runs. Verifier-cost-as-%-of-payout invariant (<1%) holds for Standard and Substantive; Micro sits at ~1% boundary, monitored.
3. **§2** Premium tier framing added: when external posters arrive, payouts scale with their budget within published ranges (Micro $0.50–$3, Standard $3–$15, Substantive $15–$500). Tier names stay constant for reputation-purposes; absolute payouts flex per poster.
4. **§2** Honest framing on operator economics: Micro $0.50 is not income, it's investment in reputation. Bootstrap pitch is "build a reputation trail that makes you valuable elsewhere," not "earn a living on Averray." Real earnings start when external posters arrive paying real money for substantive work.
5. **§10** Added "Reputation deepening (v1.x)" subsection with three high-leverage pre-launch items: public agent profile page (`averray.com/agent/<wallet>`), one-click verification flow (every receipt resolves to upstream evidence in two clicks), public read API (`api.averray.com/reputation/v1/wallet/<addr>` as protocol-style infrastructure). These don't gate v1.0.0-rc1 contract deploy but materially change marketing surface and demonstrability of the trust pitch.
6. **§10** Added "Wallet linkage (v2)" subsection clarifying that reputation portability is **portability of signal, not portability of reputation**. Soulbound non-transferability of `ReputationSBT` reaffirmed as load-bearing. Two v2 candidate mechanisms documented: operator-provable wallet linkage (signed attestations linking wallets without moving reputation) and wallet-rotation receipt protocol (formal lineage where successor wallet starts at zero but trail shows continuity).
7. **§10** Added "Reputation engagement mechanisms (v1.x)" — streak bonuses (claim-fee waiver at 25+ streak), consistency multipliers on yield-share (when v1.x yield ships, 50+ jobs in 90 days = 0.5% fee instead of 1%), tier graduation as inherent reputation signal. All increase stickiness without raising platform spend.
8. **Strategic context recorded for traceability:** the framing that "agent payment authority" platforms (Stripe Link, Visa agent commerce, OpenAI operator APIs) are *orthogonal to* rather than *competitive with* Averray's reputation primitive. Stripe-class platforms solve "how does an agent buy something"; Averray solves "is this agent's work history trustworthy." Different races. The reputation primitive's defensibility — grounded in external truth (upstream merges), content-addressed and immutable, cross-platform-readable by design — is genuinely empty space in the current market and worth deepening rather than diluting with payment-side feature additions.

### v2.1 (USDC settlement locked; revenue model formalized)

1. **§1** USDC locked as v1 escrow asset (Trust-Backed Asset, ID 1337, ERC20 precompile `0x0000053900000000000000000000000001200000`, 6 decimals — same on Polkadot Hub mainnet and Hub TestNet, verified). Resolves gating item A from previous spec versions. Native DOT explicitly out of scope for v1 contract surface.
2. **§2 Worked examples** updated with USDC-precise on-chain values (e.g. $5 = 5,000,000 at 6 decimals). Marked the env-template DOT/18-decimals defaults as a known deploy-time bug requiring fix.
3. **§2 Onboarding flow** language updated from "earns DOT" to "earns USDC" throughout. Borrow-cap re-denomination flagged as v1.0.0-rc1 pre-deploy task.
4. **§2 Wallet as earning account** rewritten as multi-asset model with explicit phasing: v1.0.0-rc1 USDC settlement only (no yield), v1.x vDOT yield strategy with platform yield-share, v1.y/v2 opt-in swap-and-stake at settlement, v2 GDOT composite yield. **Deliberate scope cut**: yield strategy removed from v1.0.0-rc1 to avoid stacking complexity.
5. **§2 Revenue model (new subsection)** formalized four revenue lines: slashed-stake split (v1), slashed claim-fee split (v1), yield-share on opt-in strategies (v1.x), swap spread at opt-in conversion (v1.y/v2). Explicit DOT-incentive logic: aUSDC excluded by design so agents who want yield must hold DOT; swap-and-stake settlement is the operator-friendly on-ramp.
6. **§2** aUSDC explicitly out of scope, with the strategic reasoning (DOT incentive) made explicit. Honest framing: not coercion, but the platform's economic flywheel benefits from DOT-yielding agents.
7. **§8 Pre-deploy items (new subsection)** added: scripts/env-template fixes, TOKEN_ADDRESS to USDC precompile, SUPPORTED_ASSETS_JSON, decimals audit. These prevent the silent 10^12 scaling bug at deploy time.
8. **§9 Threat model** added two USDC-specific entries: Circle issuer dependency (blacklist, freeze, depeg risk) and USDC regulatory exposure (money transmission / MSB licensing varies by jurisdiction). Mitigations available later (multi-asset settlement, native-DOT when contract supports it).
9. **§10** Added "Opt-in swap-and-stake at settlement" as v1.y/v2 deferred item with explicit trigger conditions (v1.x stable AND measurable bootstrap problem).
10. **§11 positioning** "Your worker wallet earns between jobs" line gated to v1.x — must not be used at v1.0.0-rc1 launch since no yield ships then.

### v2.0 (first v2-scope strategic decision recorded)

1. **§14 (new)** Added "v2 strategic direction (forward-looking, conditional on v1 signal)" — the first v2-scope decision recorded in the spec. Sequence locked: reputation distribution as v2 primary direction (next ~12 months post-v1-launch), spending authority as v2.5/v3 with architectural research running in parallel.
2. **§14** Reputation-distribution v2 work scoped concretely: public read API (protocol-style infrastructure), reference contract (~50 lines, distributed via `averray-agent-sdk` repo), three pilot integrations with Polkadot-ecosystem projects (OpenGov, Treasury bounties, hackathon judging as candidate categories). Mostly distribution and partnership work, not architectural redesign.
3. **§14** Spending-authority v2.5+ scoped as architectural research with four subareas: outbound payment authority, spend approval mechanics (three candidate models), agent-to-agent transaction primitive, non-DOT spending strategic decision (crypto-native scope vs fiat-bridge).
4. **§14** Conditional triggers explicit: direction holds if and only if v1 ships v1.0.0-rc1 successfully, week-12 gate produces ≥60% upstream merge rate, and no new market signal materially changes the competitive picture. If gate fails, v2 is "fix the work primitive" not "expand to reputation distribution."
5. **§14** Market context section captures Stripe Sessions 2026 / Stripe Link's launch as the trigger for thinking about v2 sequencing now. Stripe is taking the consumer-payment side of agentic commerce; building reputation distribution first establishes Averray as the cross-platform agent-trust layer before the spending question gets resolved by the wider market in Stripe's favor by default.
6. **§14** Trust-pitch discipline applied to roadmap claims: this section is honest about its hypothetical status. It is *not* a commitment to specific feature scope, dates, or staffing levels; *not* a directive to start v2 work before v1 ships; and *not* closed to revision.

### v1.9 (verification pass — 19 corrections from comparing spec to authoritative Polkadot docs)

External verification work resolved every ⏳ item in `AVERRAY_VERIFICATION_LEDGER.md`. Final ledger counts: ✅ 32 verified / ⚠️ 19 corrections needed / 🔬 8 empirical-only / ⏳ 0 pending. The 19 corrections below pull into this spec; **none invalidates a locked architectural decision** — XCM precompile address, SetTopic = requestId, `pallet_revive` on Asset Hub, Phase 1/Phase 2 storage split all hold.

**SetTopic semantics ✅ (no spec change needed):**

1. SetTopic-as-requestId design confirmed against upstream sources. xcm-format spec defines `SetTopic = 44 ([u8; 32])`; pallet-xcm's `WithUniqueTopic` router uses the trailing `SetTopic(id)` as the `Sent` event's `message_id` verbatim. The correlation gate design exactly matches what the upstream code does. This is the most important finding — it confirms the entire async XCM architecture rests on solid ground.

**Native DOT precompile claim retracted (§1, §10 multisig empirical entry):**

2. **§1** Removed claim that DOT is exposed via a "native DOT precompile" — no such precompile exists. `MULTISIG_SETUP.md §5` deploy template's `TOKEN_ADDRESS=0x<hub-dot-precompile-or-testdot>` field is wrong as written. Field meaning needs to be resolved (foreign-asset wrapping? test ERC-20? XCM multilocation reference?) before the deploy script is run.
3. **§10 (new)** Added "Multisig-owns-EVM-contract composition validation" as empirical-only deferred item. The composition `pallet_multisig` SS58 → `pallet_revive.map_account()` H160 → owner of `TreasuryPolicy` rests on three documented primitives but the composition itself is not documented end-to-end. Running `MULTISIG_SETUP.md §5` against testnet *is* the validation experiment. Resolve before tagging `v1.0.0-rc1` for any mainnet-adjacent purpose.

**PoP claims downgraded to community-sourced (§10 PoP entry, §11 positioning line):**

4. **§10 PoP entry** Reworded extensively. None of DIM1/DIM2 tier names, contextual aliases, Asset Hub integration in rollout scope, or v2.2.1 Phase 0 launch is documented on `docs.polkadot.com`. Spec language now flags every PoP-specific claim as community-sourced and subject to change.
5. **§10 PoP entry** Trigger updated: requires PoP mainnet maturity *AND* publication of technical spec on `docs.polkadot.com`. Documentation is now an explicit gate, not just maturity.
6. **§11 positioning line** Strengthened conditional. Was "do not use until DIM1 is mainnet-stable on Asset Hub"; now also requires "technical spec is documented on `docs.polkadot.com`."

**Yield band corrections (§2 strategy descriptions):**

7. **§2 v1 default vDOT** Yield band was "~11–14% APR base." Corrected to "~5–6% APR base" reflecting post-2026 Bifrost tokenomics reset. Added note to verify against current Bifrost docs before launch since yields shift with Polkadot inflation policy.
8. **§2 v2 strategy GDOT** Yield band was "18–25% APR." Corrected to "~15–20% APR" reflecting current leveraged-composition reality. Added note that real yield depends on leverage ratio chosen.
9. **§2 decision principle** "~12% from vDOT alone" updated to "~5–6% from vDOT alone." Argument still holds — beating CEX yield (0.5–3%) and bank savings rates is enough; the principle didn't depend on the specific number.

**Wallet-connector correction (§10 wallet-connector entry):**

10. **§10 wallet-connector entry** Corrected supported-wallet list. Previously implied MetaMask + Mimir support via `polkadot.cloud/connect`. Reality per official docs: supported list is Polkadot.js, Talisman, SubWallet, Enkrypt, Fearless, PolkaGate, Polkadot Vault, Ledger. MetaMask and Mimir are NOT supported. This sharpens the architecture: MetaMask + wagmi/viem for Asset Hub EVM accounts; `polkadot.cloud/connect` for Polkadot-native wallets specifically; Mimir-specific tooling (if needed for in-app multisig flows) evaluated separately.

**v2.2.1 runtime claims softened (no body text affected — original claims were in chat, not spec body):**

11. The "10x storage cost reduction in v2.2.1" claim from the original tweet/announcement quote does not appear on `docs.polkadot.com`. Docs only describe Asset Hub transactions as "approximately one-tenth the cost of relay chain transactions" — a comparison, not a v2.2.1-specific event. Spec body never asserted this as a verified fact, so no correction needed; this entry exists as a record that the claim is community-sourced.
12. The "2-second blocks on People Chain" claim from the same announcement is similarly not specifically attributed to People Chain in current docs. Async backing and Elastic Scaling are documented as parachain-wide capabilities, not People-Chain-specific features. Same outcome — record-of-correction only.

**Account/identity verifications (informational; no spec body change needed):**

13. `pallet_revive.map_account()` confirmed as the SS58→H160 mapping primitive. `MULTISIG_SETUP.md §4` is correct on this point.
14. `0xEE` suffix convention for EVM ↔ AccountId32 mapping confirmed verbatim. `MULTISIG_SETUP.md §4` is correct on this point. Correct source URL is `docs.polkadot.com/smart-contracts/for-eth-devs/accounts/#ethereum-to-polkadot-mapping` (not the SS58-format page that earlier spec versions referenced).

**EVM model verifications (informational; no spec body change needed):**

15. PVM / `pallet_revive` model on Asset Hub confirmed.
16. Standard Ethereum precompiles (ecrecover, sha256, etc.) confirmed available on Asset Hub EVM.
17. Foundry/Hardhat/viem/wagmi tooling confirmed as supported via documented integrations.

**Tooling verifications (informational; no spec body change needed):**

18. PAPI confirmed exposes the granularity needed to construct XCM messages with explicit instruction sequences, including SetTopic injection. `mcp-server/src/blockchain/xcm-message-builder/` design holds.
19. ParaSpell confirmed as a higher-level XCM router. Treat as reference comparison during assembler development per earlier spec; not adopted as primary tooling.
20. `pallet_multisig` deterministic address derivation from `(signatories, threshold)` confirmed verbatim. `MULTISIG_SETUP.md §3` is correct.
21. Polkadot Multisig (Signet) supports Talisman as signer wallet — confirmed.

**Hydration/Bifrost composition (informational; #7-#9 corrections cover the yield-band changes):**

22. Hydration money market does accept GDOT/aDOT as collateral for borrow — confirmed per Hydration docs. v2 Hydration-money-market borrow facility plan stands.
23. Hub→Bifrost settlement latency and Bifrost mint-failure communication remain 🔬 empirical — no docs answer these.

### v1.8 (Bulletin Chain corrections from official-doc verification)

1. **§6** Replaced "Why Bulletin Chain is the primary candidate" subsection with corrected "Phase 2 storage candidates: comparison" — explicit table of differences between Bulletin Chain and Crust, grounded in the official Bulletin Chain reference docs.
2. **§6** Corrected Bulletin Chain retention claim. Spec previously implied configurable per-blob retention covering the 6-month disclosure window. Reality (per docs): fixed ~2 weeks on Polkadot TestNet, mandatory `renew(block, index)` per blob to extend.
3. **§6** Corrected authorization claim. Spec previously said "OpenGov for mainnet, PoP eventually." Reality (per docs): `authorize_account` and `authorize_preimage` extrinsics require Root origin; OpenGov is the production path to Root, but the mainnet authorization model is "still being finalized."
4. **§6** Documented operational implication of renewal: each renewal generates new `(block, index)` pair; CID stays stable for retrieval, but renewal requires the most recent identifier pair — persistent `(cid, latest_block, latest_index, expires_at)` tracking is required.
5. **§6** Added "Choice deferred" section explicitly. Phase 2 backend choice between Bulletin Chain and Crust is now treated as a real choice to defer, not a commitment to either.
6. **§10** Replaced "Bulletin Chain primary, Crust fallback" entry with neutral "real choice between Bulletin Chain and Crust" framing. Honest about which structural-fit claims didn't survive verification.
7. **Companion document:** `AVERRAY_VERIFICATION_LEDGER.md` published. Tracks every empirical claim in the spec against authoritative docs with status flags (verified, corrections needed, pending, empirical-only). All future spec changes that reference Polkadot semantics should be cross-checked against the ledger or new verification work.

### v1.7 (operator dashboard wallet-connector library tracked)

1. **§10** Added "Operator dashboard wallet-connector library" deferred entry. v1 uses plain viem/wagmi with MetaMask + Talisman; reach for polkadot.cloud/connect when external operator count and wallet diversity justify the dependency. Agents never use a wallet-connector library — programmatic signing only.

### v1.6 (Polkadot v2.2.1 awareness)

1. **§6** Storage Phase 2 reframed: Bulletin Chain (post-v2.2.1) is primary candidate; Crust IPFS pinning is fallback. Both IPFS-compatible — content-addressing discipline from day one means migration is trivial regardless.
2. **§6** Added "Why Bulletin Chain is the primary candidate" subsection: CID = our content hash; renewal-based retention maps directly to disclosure timing; no per-byte fees forever; same trust boundary as the rest of the stack; IPFS-compatible as escape hatch.
3. **§6** Documented mainnet authorization gate: OpenGov referendum required (or future PoP-based authorization). Testnet free via faucet for v1.0.0-rc1 development. OpenGov authorization is a discrete v2 milestone — real ecosystem engagement, not configuration.
4. **§10** Replaced "IPFS / Crust migration" deferred entry with "Phase 2 storage migration: Bulletin Chain primary, Crust fallback" — explicit about the OpenGov authorization milestone.
5. **§10** Added Proof of Personhood (PoP) integration as deferred item with two specific use-cases: DIM1 for operator signup (Sybil resistance against fleet-of-fake-operators bootstrap-budget attack), DIM2 for Phase 2 arbitration eligibility (higher-stakes role). Trigger is PoP mainnet maturity. Asset Hub integration must be verified before depending on it.
6. **§11** Added PoP-conditional positioning line about operator-level Sybil resistance.

### v1.5 (parameter tunability and experimentation discipline)

1. **§14 (new)** Added parameter tunability tier model: Tier 1 (off-chain, change anytime), Tier 2 (multisig admin call), Tier 3 (contract redeployment), Tier 4 (fixed by design — changing undermines the trust pitch).
2. **§14** Added experimentation discipline: hold parameters stable through week-12 gate, one variable at a time, write decision criteria before running experiments.
3. **§14** Distinguished friction levers (claim stake, fee floor, dispute window) from incentive levers (bounty amounts) — different problems require different tunables.
4. **§14** Documented three load-bearing metrics for parameter calibration: merge rate (incentive), claim rate (friction), dispute rate (verifier).
5. **§14** Added `docs/PARAMETER_CHANGES.md` log requirement with mandatory pre-change fields (hypothesis, target metric, observation window, decision rule).

### v1.4 (yield strategy portfolio model)

1. **§2** Replaced single-vDOT "Wallet as earning account" subsection with yield-strategy portfolio framing. Strategies treated as a portfolio behind the existing `XcmVdotAdapter` pattern, not a fixed choice. Conservative-by-default posture: platform is sensible by default but doesn't ceiling agents.
2. **§2** v1 default locked: moderate auto-allocation to Bifrost vDOT. Single-hop XCM, ~12% APR, single vendor surface, well-understood risk. The marketing line "Your worker wallet earns between jobs" doesn't require maximum yield — beating CEX yield (0.5–3%) is enough.
3. **§2** v2 strategy locked: Hydration GDOT as opt-in composite-yield adapter, never auto-allocated. Targets 18–25% APR but doubles vendor surface and requires multi-hop XCM correlation. Worth shipping after v1 vDOT is empirically stable.
4. **§2** v2 borrow facility direction: route `BORROW_CAP` through Hydration money market (collateralized against GDOT/aDOT) instead of building native liquidation mechanics. Cleaner risk model — Averray no longer carries lender-of-last-resort exposure, borrow scales with actual collateral, audited liquidation already exists.
5. **§10** Added Hydration GDOT strategy adapter and Hydration money market borrow facility as v2 deferred items, with explicit triggers and rationale.
6. **§11** Updated vDOT positioning line to reflect strategy portfolio framing.

### v1.3 (arbitration evolution path; on-chain dispute flow grounded)

1. **§3** Corrected three-roles table: arbitrator authority is `TreasuryPolicy.arbitrators` mapping with `setArbitrator(address, bool)` — multi-arbitrator by design, not single-target.
2. **§3** Corrected slash split: 50/50 poster/treasury, zero to arbitrator at launch (Phase 0–1). Restructure deferred to Phase 2 when agent-arbitrators need real economic incentive.
3. **§3** Added arbitration evolution path: Phase 0 (human, Pascal) → Phase 1 (LLM-as-judge supervised) → Phase 2 (tiered agent quorum) → Phase 3 (permissionless tier). Triggers are data-driven (override rate, dispute volume) not calendar-based.
4. **§3** Added separate eligibility ladders: internal-jobs (~30 merges, 6 months) is distinct from arbitration (~100 merges, 12 months, stake bond, calibration test). Two ladders, earned independently.
5. **§3** Documented Phase 0 dispute process grounded in actual contract surface: `EscrowCore.openDispute` → `resolveDispute(jobId, workerPayout, reasonCode, metadataURI)`. `metadataURI` carries hashed off-chain reasoning per disclosure model.
6. **§3** Verifier accountability via public trail: overturned arbitrations record on the verifier's reputation, no new contract logic.
7. **§8** Added three contract changes for arbitration safety:
   - `EscrowCore.openDispute` enforces `DISPUTE_WINDOW` (bumped 1 day → 7 days) — removes operator-cron dependency.
   - New `EscrowCore.autoResolveOnTimeout(jobId)` — permissionless, after `ARBITRATOR_SLA = 14 days`, agent-favorable default (system unavailability is platform's failure).
   - `disputedAt` timestamp on job state and `Disputed` event for SLA enforcement.
8. **§8** Added reason-code registry: existing `REJECTED` and `DISPUTE_LOST` plus new `DISPUTE_OVERTURNED`, `DISPUTE_PARTIAL`, `ARB_TIMEOUT`, `MUTUAL_RELEASE` as off-chain conventions (no contract changes; field is freeform).
9. **§10** Added Phase 1/2/3 arbitration items, Phase 2 dispute compensation restructure, internal-jobs eligibility ladder.
10. **§11** Added two positioning lines (tiered access; data-driven migration). Both conditional on real Phase 2 maturity.
11. **§12** Added dispute-flow backend wiring checklist (`POST /disputes/:id/verdict` and `/release` currently scaffolded, must dispatch to `EscrowCore.resolveDispute` at launch).
12. **§12** Added Phase 0 arbitrator setup items (multisig calls `setArbitrator`, Ledger provisioning, public migration commitment).

### v1.2 (XCM correlation gate, async lane scoping)

1. **§8** Added `XcmWrapper.queueRequest` SetTopic-validation as a v1.0.0-rc1 contract change. Decode last instruction of `message`; reject if not `SetTopic(requestId)`. Defense-in-depth against assembler bugs.
2. **§9** Added "Async XCM lane: untrusted input surface" threat model entry. Documents the current `/account/allocate` accept-arbitrary-bytes pattern and the gating requirement until the backend assembler ships.
3. **§10** Replaced the "three candidates, none locked" framing with two explicit, dependent work items: backend SCALE assembler (foundational) and native XCM observer correlation gate (depends on assembler, validated via Chopsticks). SetTopic = requestId is the chosen correlation primitive; Bifrost reply-leg preservation is the empirical gate.
4. **§10** Documented the current async XCM lane reality: scaffolded only, no production SCALE assembler, HTTP layer accepts raw bytes, no SetTopic anywhere in codebase, `XcmWrapper.requestMessageHash` is `keccak256(rawBytes)` not the XCM-protocol `messageId`.
5. **§12** Replaced the placeholder async XCM checklist with concrete items: assembler shipped, HTTP intent-routing live, backend computes/appends SetTopic, wrapper validation check, Chopsticks confirmation, staging proof.

### v1.1 (reconciliation against deployed reality and operational docs)

1. **§2** Split claim stake (10%, dispute-slashable) from claim fee (`max(2%, $0.05)`, anti-spam). Both refunded on success.
2. **§2** Borrow-to-stake reframed as durable post-onboarding flow, not v2.
3. **§2** Added vDOT strategy as wallet-as-earning-account framing.
4. **§3** Arbitrator role distinguished from peer-verifier re-review. Penalty-driven dispute discipline replaces compute-driven.
5. **§7** Disclosure events emit from existing session contract, not new `DisclosureLog`.
6. **§8** Removed `VerifierRegistry` as new contract. Replaced with extension to existing verifier mapping (`authorizedSince`/`authorizedUntil`/`wasAuthorizedAt`).
7. **§8** Confirmed `DiscoveryRegistry` is the only genuinely new contract.
8. **§9, §10, §11, §12** Folded in references to `MAINNET_PARAMETERS.md`, `MULTISIG_SETUP.md`, `SIGNER_POLICY.md`, `ASYNC_XCM_STAGING.md`, `NATIVE_XCM_OBSERVER.md` where directly relevant.
9. **§10** Native XCM observer correlation gate added explicitly as v1.x prerequisite for self-sufficient async settlement.
10. **§11** Added vDOT positioning line.


---

*Last updated: 2026-05-07*
