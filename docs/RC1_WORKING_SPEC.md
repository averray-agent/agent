# Averray - Working Spec (v1.0.0-rc1)

**Status:** Reconciled with deployed reality and operational docs  
**Spec version:** 1.4 (yield strategy portfolio model; vDOT as v1 moderate default; Hydration GDOT and money-market borrow scoped as v2)
**Owner:** Pascal  
**Last updated:** 2026-04-26

## Summary

Averray is trust infrastructure for software agents on Polkadot Hub (Asset Hub EVM). The platform runs as a marketplace take-rate model with no platform token, sustained by fees and structurally honest receipts. Reputation is bootstrapped by funding agent contributions to public OSS and Wikipedia where the upstream merge itself is the verdict - no posters required to seed the trail. Source of truth lives on-chain (commitments, identity, payouts) with hashes binding to off-chain content. Idle wallet balance earns vDOT yield via async XCM to Bifrost, making worker wallets durable earning accounts. Sustainability target is fee-funded operations within 6-12 months of public launch.

## 1. Business model

### Locked

- **Marketplace take rate (Model A).** Revenue scales with settled-escrow GMV.
- **Polkadot Hub (Asset Hub EVM) as the production target.** Cheap tx, EVM compatibility, native DOT precompile, XCM for cross-chain capital. Architectural fit, not a beachhead.
- **"Be early" posture.** 3-5 year bet on becoming the canonical surface for agent work; near-term goal is reputation density and platform sustainability, not extraction.
- **No platform token, ever.** Fee-funded forever. Reputation is non-transferable. No airdrop, no points, no governance token. *"Averray is a blockchain product, not a token product."*

### Why blockchain

Blockchain is the architectural fit because the product needs **public, verifiable, third-party-checkable receipts** that survive the platform itself. Wallet identity, settlement finality, and an immutable event trail are load-bearing. The product is not crypto-speculative; it does not require a token to function or to capture value.

## 2. Economics

### Bootstrap budget

- **$50/week** spent on bounties to seed reputation. Hard cap.
- Distribution per week:
  - ~15 light jobs at $1 each -> $15
  - ~5-7 substantive jobs at $5-7 each -> ~$35
- ~80 jobs/month, ~480 in the trail by month 6.

### Job sourcing

- **GitHub Issues** from a denylist-defaulted set of repos.
- **Wikipedia mechanical edits** (typo fixes, dead-link replacements, citation formatting). No prose contributions in v1.
- All jobs are sourced upstream. Averray funds completion, the agent submits the fix, the maintainer chooses to merge or close. No outreach, no spam, no obligation.

### Two distinct economic primitives at claim time

The platform charges a working agent two layered amounts at claim. They serve different purposes and live in different places.

| Primitive | Source / parameter | Purpose | Returned on verified success? | Slashed on failure? |
|---|---|---|---|---|
| **Claim stake** | `DEFAULT_CLAIM_STAKE_BPS = 1000` (10% of payout), enforced inside `AgentAccountCore` | Substantive bond against bad-faith claims. Carries reputation penalty weight via `DISPUTE_LOSS_SKILL_PENALTY = 35` and `DISPUTE_LOSS_RELIABILITY_PENALTY = 60`. | Yes, full return | Yes, on dispute-loss |
| **Claim fee** | New, `max(2% of payout, $0.05)` | Anti-spam friction at claim time. Funds verifier compute on the failure path. | Yes, full return | Yes, on no-show or rejected submission. 70% to verifier, 30% to platform treasury. |

**Worked examples (post-onboarding):**

| Job tier | Payout | Stake (10%) | Fee | Total locked at claim | Net cost on success |
|---|---:|---:|---:|---:|---:|
| Light | $1 | $0.10 | $0.05 (floor) | $0.15 | $0 |
| Substantive | $5 | $0.50 | $0.10 (2% binds) | $0.60 | $0 |
| Substantive | $7 | $0.70 | $0.14 | $0.84 | $0 |

Working agent pays nothing net. Bad actors fund both reputation penalties and verifier compute on every failed attempt.

### Onboarding flow

A new agent never needs upfront DOT to start working:

1. **SIWE sign-in** -> worker wallet exists.
2. **First 3 jobs claimed without stake or fee.** Both waived. Agent earns DOT from these jobs into the wallet's `AgentAccountCore` balance.
3. **Job 4 onward, two paths converge:**
   - Use accumulated DOT from jobs 1-3.
   - Or borrow against the per-account `BORROW_CAP = 25 DOT` to bridge stake on a higher-tier job.
4. **On settlement,** payout repays any outstanding borrow first; surplus settles to wallet balance and optionally into the vDOT strategy.

Borrow-to-stake is the durable model, not a v2 item. It exists in the contract suite already (`BORROW_CAP = 25 DOT`, flat per-account, current launch profile).

### Wallet as earning account: yield strategy portfolio

Idle DOT in `AgentAccountCore` can be allocated into yield strategies via the async XCM lane. Agents earn yield between jobs. This is real stickiness: switching off Averray means unwinding a yield position, not just changing a default.

The platform treats yield strategies as a **portfolio**, not a fixed choice. Different agents have different risk tolerances, and the Polkadot DeFi landscape evolves faster than launch-time architecture should lock in. The existing `XcmVdotAdapter.sol` pattern already isolates this concern; new strategies ship as new adapters behind the same `XcmWrapper` surface.

**v1 default: moderate auto-allocation to vDOT (Bifrost).**

- Idle balance above a threshold auto-allocates to vDOT via single-hop XCM to Bifrost.
- Indicative yield: ~11-14% APR base from native staking rewards.
- Single vendor (Bifrost), single XCM hop, single correlation primitive (`SetTopic` preserved on reply-leg, pending Chopsticks confirmation).
- Lowest vendor surface and well-understood risk.
- Conservative-by-default for trust infrastructure: the platform is sensible by default but does not ceiling agents who want more.

**v2 strategy: Hydration GDOT (composite yield).**

- New `HydrationGdotAdapter` alongside `XcmVdotAdapter`. Same `XcmWrapper` surface; different backend SCALE assembler; different observer correlation logic.
- Indicative target yield: 18-25% APR from four sources: vDOT staking, aDOT lending, vDOT/aDOT pool trading fees, and Hydration/Polkadot treasury incentives.
- Tradeoffs: doubled vendor surface (Hydration + Bifrost), multi-hop XCM (Hub -> Hydration -> Bifrost -> Hydration -> Hub), exposure to Hydration's drifting-peg mechanism, Omnipool pricing, and HDX governance.
- Opt-in only. Agents explicitly choose this strategy; never auto-allocated.

**Decision principle for the portfolio:**
The marketing line *"Your worker wallet earns between jobs"* does not require maximum yield to be true. Around 12% from vDOT alone meaningfully beats typical CEX yield assumptions. The marginal benefit of GDOT over vDOT is not worth doubling vendor surface and complicating XCM correlation at launch. Ship vDOT first, validate the correlation gate, then add GDOT as an upgrade path for agents who want it.

**Hydration money market for borrow facility (v2):**
The existing `BORROW_CAP = 25 DOT per account` runs on Averray's own balance sheet: the platform is the lender. When liquidation mechanics ship, strongly consider routing the borrow facility through Hydration's money market instead of building it natively. That changes `BORROW_CAP` from "Averray's exposure ceiling" to "max LTV against agent's GDOT/aDOT collateral on Hydration." Cleaner risk model: Averray no longer carries lender-of-last-resort exposure, borrow caps scale with actual collateral rather than a flat number, and liquidation mechanics already exist at the money-market layer. Reputation-weighted credit becomes a small additional reservoir on top of Hydration's collateral-based lending, rather than the entire borrow primitive.

### Sustainability principles

- Verifier compute cost must stay **under 1% of payout** as a design invariant. If a new job type breaks this, re-price before launching it.
- Platform treasury inflows from slashing are intended to fund verifier operations and platform sustainability, not to be redistributed to holders (there are none).

## 3. Verifier and arbitrator model

### Three distinct roles

| Role | Authority source | Purpose | Compensation |
|---|---|---|---|
| **Verifier** | On-chain mapping (set via `setVerifier(address, bool)`) | Decides pass/fail at submission against job schema. Co-signs receipts. | Fixed per-verification budget (~$0.02), funded by claim fees on the failure path |
| **Arbitrator** | `TreasuryPolicy.arbitrators` mapping, set via `setArbitrator(address, bool)`. Multi-arbitrator by design; phase 0 means the approved set has size 1. | Adjudicates disputes when an agent contests a verdict. Final on-chain via `EscrowCore.resolveDispute(jobId, workerPayout, reasonCode, metadataURI)`. | Phase 0-1: unpaid. Phase 2+: split of slashed stake activates with agent-arbitration. |
| **Pauser** | Single hot key (1-of-1 EOA), not part of multisig | Emergency `setPaused(bool)` capability. Cannot move funds; only freezes. | n/a |

The arbitrator is **not** a peer verifier doing re-review. It is a designated role with sharper consequences: 35/60 skill/reliability penalties on dispute-loss versus 10/25 on plain rejection.

### Verifier strategy

| Job type | Verifier mechanism | Per-verification cost |
|---|---|---|
| GitHub PR jobs | Upstream merge within deadline (GitHub API poll) | ~$0 |
| Wikipedia edits | Survives 7 days unreverted (MediaWiki API poll) | ~$0 |
| Subjective work (future) | Haiku-class LLM-as-judge | ~$0.03 |
| Disputes / arbitration | Arbitrator review (human or human-in-loop, not LLM-as-judge) | n/a - funded by slashed stake |

**Blended cost per verification at planned mix:** ~$0.013. Budgeted at **$0.02** for safety margin.

### Deadline policy for upstream-gated jobs

PRs can sit for weeks before maintainer review. The verifier needs three states:

1. **Provisional pass** - at submission, before merge.
2. **Confirmed pass** - at upstream merge, SBT minted.
3. **Fail-and-refund-poster** - at deadline if neither merge nor close within configured window.

Default deadline: **30 days** for GitHub PRs, **14 days** for Wikipedia edits. Configurable per repo.

### Dispute-rate discipline

The cost discipline that keeps disputes rare is the penalty structure. An agent who escalates a weak submission and loses takes a 35/60 reputation hit plus loses their stake. Disputes get filtered economically, not by friction. Still instrument from day one: log every dispute, watch the rate weekly, and re-price if it climbs above 10%.

### Arbitration evolution path

The arbitrator role evolves in phases. Each phase has data-driven gates rather than calendar-only dates.

**Phase 0 - launch through ~50 disputes: human arbitrator (Pascal).**  
Single approved address in `TreasuryPolicy.arbitrators`. Hardware-wallet custody with a dedicated Ledger separate from multisig cold keys. Annual time-based key rotation, immediate rotation on suspected compromise via multisig `setArbitrator(oldAddr, false)` + `setArbitrator(newAddr, true)`. Public commitment to migrate by month 6 or first 50 disputes, whichever comes first.

**Phase 1 - ~50-250 disputes: human-supervised LLM arbitration.**  
Same on-chain role. New tool: an LLM-as-judge pre-analyzes each dispute and proposes a verdict with reasoning. Pascal upholds or overrides. Override rate is the metric. Migrate to Phase 2 only when override rate sits below 10% sustained.

**Phase 2 - 250+ disputes, override rate <10% sustained: tiered agent arbitration.**

- **Stake tiering.** Low-stake disputes route to qualified agents. High-stake disputes escalate to human review.
- **Quorum.** Agent-arbitrated disputes require N-of-M independent signed verdicts. 2-of-3 is the v2 default. Disagreement escalates.
- **Arbitrator-agent staking.** Eligible agents post a bond from wallet balance. Overturned arbitration costs 50/80 reputation.
- **Conflict-of-interest exclusion.** Arbitrator-agent cannot be involved in the dispute, share operator wallet with either party, or have submitted to the same repo recently.
- **Deterministic selection.** Eligible arbitrator pool selected from on-chain criteria and deterministic on-chain randomness, not a backend lottery.

**Phase 3 - fully decentralized arbitration tier.**  
Permissionless registration for agents meeting on-chain criteria: N successful jobs, M months active, stake bond, no recent disputes lost. Human escalation reserved for highest-tier disputes only.

### Two separate eligibility ladders

| Ladder | Bar | What it unlocks |
|---|---|---|
| **Internal jobs** | ~30 successful merges + 6 months active | Operator-tier work: PR review of less-trusted agents, denylist curation, context-bundle drafting, spam-pattern monitoring. Labor delegation. |
| **Arbitration** | ~100 successful merges + 12 months active + stake bond + calibration test pass | Voting-eligible arbitrator on disputes routed to agent quorum. Judgment delegation. |

Different roles need different evidence. Internal jobs and arbitration are separate ladders, earned independently.

### Dispute process (Phase 0)

The on-chain primitives already exist in `EscrowCore`:

1. **Verifier issues verdict.** Job state transitions to `Rejected` or stays eligible for pass settlement per the existing flow.
2. **Agent disputes.** Within the dispute window (post-launch: 7 days from rejection), agent calls `EscrowCore.openDispute(jobId)`. State transitions to `Disputed`. Stake remains locked.
3. **Reasoning submitted off-chain.** Agent's dispute reasoning is stored under `sha256(canonicalJSON(reasoning))`, served at `/content/:hash`. Default visibility is owner-only with 6-month auto-public.
4. **Arbitrator notified.** Out-of-band notification plus operator app dispute queue.
5. **Arbitrator reviews.** Reads verifier reasoning, agent reasoning, submission, upstream evidence, and related context.
6. **Arbitrator signs verdict.** Calls `EscrowCore.resolveDispute(jobId, workerPayout, reasonCode, metadataURI)`:
   - `workerPayout`: full remaining for overturn, zero for upheld, partial for split outcomes.
   - `reasonCode`: from the reason-code registry.
   - `metadataURI`: hash-addressed URL pointing at arbitrator reasoning content.
7. **Settlement finalizes.** SBT minted/withheld accordingly. Stake returned on overturn or slashed 50/50 poster/treasury on upheld dispute. Reputation penalties apply per `MAINNET_PARAMETERS.md`.
8. **SLA fallback.** If arbitrator does not act within 14 days (`ARBITRATOR_SLA`), anyone can call `EscrowCore.autoResolveOnTimeout(jobId)`, forcing favorable-to-agent resolution with `REASON_ARBITRATOR_TIMEOUT`.

**Slash split at launch:** 50% poster, 50% platform treasury. Zero to arbitrator at Phase 0-1. Restructured in Phase 2 to compensate agent-arbitrators.

**Verifier accountability:** overturned arbitrations record on the verifier's public trail. Sloppy verification becomes visible without adding a new contract primitive.

## 4. Maintainer policy

### Locked

- **Denylist, not allowlist.** Default open. Remove repos that ban AI in `CONTRIBUTING.md` plus a hand-curated security/standards denylist.
- **Mandatory disclosure footer** appended to every PR/edit body, platform-injected, non-removable.
- **Per-repo open PR cap: 3** simultaneously. No weekly per-wallet cap.
- **Respect the no.** Any signal from a maintainer to stop means repo to denylist immediately.

### Disclosure footer template

```text
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

We submit already-fixed problems. We never write directly. The contribution is free. The maintainer chooses to merge or close, no offense either way.

### Wikipedia caveat

Wikipedia has stricter AI-content policies than GitHub norms. Scope to mechanical edits only for v1. Prose contributions are a separate v2 conversation.

## 5. Bootstrap discipline (week-12 gate)

### Single metric

**Upstream merge rate on funded jobs.**

- GitHub: PRs merged into upstream within deadline.
- Wikipedia: edits surviving 7 days unreverted.

Not on-chain receipt count, job claim rate, or wallet count.

### Evaluation window

Evaluate at **week 12**, using only jobs **submitted in weeks 1-8**. This gives a 4-week settle window for review latency.

### Thresholds and actions

| Merge rate | Action |
|---|---|
| >=60% | Working. Continue at $50/wk, plan scale-up. |
| 40-59% | Marginal. Continue at $50/wk for 4 more weeks, hard re-evaluate at week 16. |
| <40% | Not working. Cut budget to $25/wk, run diagnostic before adding spend. |

### Diagnostic order if marginal/failing

1. Review velocity - are PRs getting reviewed at all? If not, repo selection problem.
2. Reject reasons - if reviewed and rejected, read close reasons. If "wrong fix," tighten intake.
3. Style/process rejections - add per-repo style profiles to context bundles.
4. Last hypothesis: agents are bad. Do not skip to this.

### Required instrumentation

- `funded_jobs` table: every job posted, bounty paid, final upstream status (`merged | closed_unmerged | open_stale | reverted`). Updated daily by an upstream-status poller.
- Weekly auto-generated self-report: merge rate, total spend, total receipts, top 3 close reasons.

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
| Strategy allocation (`AgentAccountCore` -> vDOT) | |

Every on-chain event referencing off-chain content carries `sha256(canonicalJSON(content))` as a permanent commitment.

### Storage phases

- **Phase 1:** Averray API only. `/content/:hash` serves blobs by content hash. Append-only log of every `(hash, payload, timestamp)` tuple to separate object storage.
- **Phase 2:** Crust IPFS mirror. Pin every content blob, store CID alongside hash. Reads try IPFS first, fall back to API.

### Day-one disciplines

1. Content-address from the start. Compute `sha256(canonicalJSON(payload))` before writing. Store under that hash as primary key.
2. Emit hash in every relevant event: `JobCreated(jobId, specHash, ...)`, `Submitted(sessionId, payloadHash)`, `Verified(sessionId, reasoningHash, verdict)`.
3. Use JCS canonicalization (RFC 8785). Verifier rejects submissions whose hash does not match canonical form.
4. Write an append-only recovery log with daily-rotated content dumps.

### Explicitly not on-chain

- **Reputation scores.** SBTs are the primitive; scoring is computed off-chain by the indexer.
- **Discovery directory contents.** Served by API; only the manifest hash is anchored on-chain.

## 7. Disclosure model

### Visibility rules

| Content type | Default visibility | Auto-public after |
|---|---|---|
| Job specs | Always public | n/a |
| Passes (submissions + verifier reasoning) | Public immediately | n/a |
| Failed submissions | Owner-only | 6 months |
| Failed verifier reasoning | Owner-only | 6 months |

- **Owner-controlled early publish.** Agent can publish any of their own content at will. One-way only: once published, permanent.
- **Counterparty access during window.** Deferred to v1.1.

### Implementation

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

- Public if `published_at` is set.
- Public if `now() >= auto_public_at`.
- Public if `verdict = 'pass'` and content type is not sensitive-by-default.
- Otherwise owner-only.

### Cache strategy

- Private-window reads: `Cache-Control: public, max-age=N`, where `N = min(auto_public_at - now(), 3600)`.
- Public reads: `Cache-Control: public, max-age=31536000, immutable`.

### On-chain disclosure events

Emitted from the existing session lifecycle contract, whichever contract emits `Submitted` and `Verified`, not a new `DisclosureLog` contract.

```solidity
Disclosed(hash, byWallet, timestamp)
AutoDisclosed(hash, timestamp)
```

`AutoDisclosed` is emitted lazily on first read after `auto_public_at` passes. The API checks whether it has been emitted, emits if not, then serves.

## 8. v1.0.0-rc1 redeployment scope

The foundation extensions for staking/slashing, disclosure events, hash binding, and historical verifier query break storage compatibility. They ship together in one redeployment wave.

### New contracts

#### `DiscoveryRegistry`

Anchors the manifest hash of `/.well-known/agent-tools.json` on-chain. Closes the gap where the directory could be silently modified or served differently to different agents.

```solidity
contract DiscoveryRegistry {
    address public publisher;
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

CI must hash the canonical JSON (JCS) and call `publish()` automatically on directory deploy.

### Extensions to existing contracts

| Contract | Change | Why |
|---|---|---|
| Verifier mapping (`TreasuryPolicy` or equivalent) | Add `authorizedSince[address]`, `authorizedUntil[address]`, and `wasAuthorizedAt(address, uint64) view returns (bool)`. `setVerifier(address, bool)` writes to the new fields. | Retroactive audit of SBTs. |
| `EscrowCore` | Add hash fields to events: `JobCreated(..., specHash)`, `Submitted(..., payloadHash)`, `Verified(..., reasoningHash)`. | Bind off-chain content to on-chain commitments. |
| `EscrowCore` | Emit `Disclosed(hash, byWallet, ts)` and `AutoDisclosed(hash, ts)` from existing session paths. | Disclosure model integrity without a new contract. |
| `ReputationSBT` | Hard-revert on `transfer` and `transferFrom` with `Soulbound()`. | Non-transferability as a contract property. |
| `XcmWrapper.queueRequest` | Add SetTopic validation: reject if the message's canonical suffix is not `SetTopic(requestId)`, where `requestId == previewRequestId(context)`. | Defense-in-depth against assembler bugs and XCM correlation gaps. |
| `EscrowCore.openDispute` | Add deadline check: revert if `block.timestamp > rejectedAt + DISPUTE_WINDOW`. Bump `DISPUTE_WINDOW` from 1 day to 7 days. | Self-enforcing dispute window. |
| `EscrowCore` | Add `autoResolveOnTimeout(bytes32 jobId)`, permissionless after `ARBITRATOR_SLA = 14 days` from `disputedAt`. Full payout to worker with `REASON_ARBITRATOR_TIMEOUT`. | Stake never locks indefinitely. |
| `EscrowCore` | Add `disputedAt` timestamp to job state and emit it in the dispute event. | Required for SLA enforcement. |

### Reason-code registry

`EscrowCore.resolveDispute` accepts freeform `bytes32 reasonCode`. The
canonical registry lives in [DISPUTE_CODES.md](DISPUTE_CODES.md). The platform
conventions are documented and indexer-recognized:

| Code (`bytes32`) | Meaning | Typical `workerPayout` |
|---|---|---|
| `REJECTED` | Initial verifier rejection | 0 |
| `DISPUTE_LOST` | Arbitrator upheld verifier; agent loses dispute | 0 |
| `DISPUTE_OVERTURNED` | Arbitrator overturned verifier; agent wins | full remaining |
| `DISPUTE_PARTIAL` | Arbitrator awarded partial | partial |
| `ARB_TIMEOUT` | Auto-resolved on SLA miss | full remaining |
| `MUTUAL_RELEASE` | Both parties agreed to release without dispute | negotiated |

`REJECTED` and `DISPUTE_LOST` already exist in code. The other four are conventions, not contract restrictions. Indexer normalizes unknown codes to `REASON_UNKNOWN`.

### Indexer updates

Ponder schema picks up:

- `ManifestPublished` from `DiscoveryRegistry`.
- New hash fields on `JobCreated`, `Submitted`, and `Verified`.
- `Disclosed` and `AutoDisclosed` events.
- Verifier mapping changes (`authorizedSince`, `authorizedUntil`).
- Dispute lifecycle: `DisputeOpened`, `DisputeResolved` (with `reasonCode`, `metadataURI`), `AutoResolvedOnTimeout`.
- `disputedAt` timestamp tracking for SLA monitoring.

### Migration note

Existing deployed instances are superseded. The redeployment wave is the same one that introduced staking/slashing, not an additional break.

## 9. Threat model entries

To live in `THREAT_MODEL.md`:

- **Verifier key compromise.** Bounded by historical query; `wasAuthorizedAt` lets future audits identify the compromised window. Mitigations include key rotation, verdict-volume anomaly monitoring, and multi-verifier for high-value jobs.
- **Platform signer compromise.** Publisher of `DiscoveryRegistry`, admin of verifier mapping. Multisig migration is the long-term answer.
- **Pauser compromise.** Single hot key with `setPaused(bool)` only. Compromise freezes the system, does not drain it.
- **Disclosure window abuse.** On-chain verdict events are public from day one; only reasoning content is delayed.
- **Maintainer-side reputation poisoning.** Hostile maintainer mass-closes PRs. Mitigation: merge rate weighted by repo and denylist auto-removes problem repos.
- **Native XCM observer correlation gap.** Until deterministic correlation is validated, async settlement leans on internal manual observe path.
- **Async XCM lane: untrusted input surface.** Current `/account/allocate` and `/account/deallocate` endpoints accept arbitrary `destination` and `message` bytes. Until the backend SCALE assembler ships, async treasury endpoints must remain admin-gated.

## 10. Deferred / open items

- **Counterparty access during disclosure window.** Adds a fourth visibility input. Ship in v1.1.
- **Multi-verifier for high-value jobs.** Quorum signing. v2.
- **Verifier key rotation policy.** Concrete cadence and mechanism.
- **IPFS / Crust migration.** Phase 2 of source-of-truth.
- **Subjective job types.** Require LLM-as-judge verifier and re-pricing.
- **Backend SCALE assembler with `SetTopic = requestId`.** Current async XCM lane is scaffolded only: `XcmWrapper.queueRequest` hashes raw `destination`/`message`, HTTP accepts arbitrary bytes, no production SCALE builder exists, and no SetTopic appears in the codebase. Required work: build `mcp-server/src/blockchain/xcm-message-builder.js`, replace raw bytes with intent-based routing, have backend assign nonce and mirror `previewRequestId(context)`, append `SetTopic(requestId)` as the last instruction, then submit to wrapper.
- **Native XCM observer correlation gate.** Depends on the assembler. Validate with Chopsticks whether Bifrost preserves SetTopic on reply-leg. Fallbacks: serialized per-strategy dispatch queue, then amount-perturbation only as last resort.
- **Liquidation mechanics for borrow facility.** Current flat `BORROW_CAP = 25 DOT`, no liquidation. Conservative `MIN_COLLATERAL_RATIO_BPS = 20000` holds the line until liquidation ships.
- **Reputation-weighted borrow caps.** v2.
- **Phase 1 arbitration.** LLM-as-judge calibration for human arbitrator review. Trigger: ~50 disputes resolved.
- **Phase 2 arbitration.** Tiered agent quorum, arbitrator-agent stake bond, conflict-of-interest registry, deterministic selection, N-of-M signatures, harsher penalties for overturned arbitration.
- **Phase 2 dispute compensation restructure.** Change slash split from 50/50 poster/treasury to a three-way split that compensates agent-arbitrators.
- **Phase 3 arbitration.** Permissionless arbitration tier.
- **Internal-jobs eligibility ladder.** Separate from arbitration. Lower bar (~30 merges + 6 months).
- **Hydration GDOT strategy adapter.** New `HydrationGdotAdapter` alongside `XcmVdotAdapter`, using the same `XcmWrapper` surface. Composite yield from vDOT, aDOT, pool fees, and incentives. Multi-hop XCM requires extending the correlation gate verified for single-hop Bifrost. Opt-in only, never auto-allocated. Ship after the v1 vDOT strategy is empirically stable.
- **Hydration money market borrow facility.** Replace native flat `BORROW_CAP = 25 DOT` balance-sheet lending with collateralized borrowing against agent-held GDOT/aDOT on Hydration's money market. This reduces Averray's lender-of-last-resort exposure, scales borrow with actual collateral, and reuses money-market liquidation mechanics. Trigger when native liquidation mechanics would otherwise need to be built.

## 11. Marketing / positioning lines

- *"Averray is a blockchain product, not a token product."*
- *"No token. No airdrop. No points program."*
- *"Receipts, not vibes."*
- *"Failed attempts are private for 6 months, then join the public record."*
- *"The first thing Averray sells is trust, not yield."*
- *"Your worker wallet earns between jobs."* (yield-strategy portfolio positioning; v1 default is vDOT auto-allocation)
- *"Reputation unlocks tiered access: high-trust agents earn internal work; the highest tier earn arbitration rights."* (valid only once Phase 2 is real)
- *"We migrate to agent arbitration when the data says we can, not when the narrative wants us to."*

## 12. Pre-launch checklist

### Instrumentation

- [ ] `funded_jobs` table live and populating.
- [ ] Daily upstream-status poller running against GitHub and MediaWiki APIs.
- [ ] Weekly self-report email scheduled.

### Contract surface

- [ ] `DiscoveryRegistry` deployed, CI publishing on directory updates.
- [ ] Verifier mapping extended with `wasAuthorizedAt` (no new contract).
- [ ] `ReputationSBT` non-transferable at contract level.
- [ ] Hash fields live on `JobCreated`, `Submitted`, and `Verified`.
- [ ] `Disclosed` and `AutoDisclosed` events live on session lifecycle contract.
- [ ] `EscrowCore.openDispute` enforces deadline window.
- [ ] `DISPUTE_WINDOW` bumped from 1 day to 7 days.
- [ ] `EscrowCore.autoResolveOnTimeout(jobId)` shipped with `ARBITRATOR_SLA = 14 days`.
- [ ] `disputedAt` timestamp present on job state and emitted in dispute event.

### Content storage

- [ ] `/content/:hash` serving with visibility resolved at read time.
- [ ] Append-only recovery log writing to object storage.

### Agent/maintainer surface

- [ ] Disclosure footer auto-injected into every PR/edit.
- [ ] Per-repo 3-PR cap enforced.
- [ ] Denylist live with security/standards repos pre-populated.

### Multisig and ops

- [ ] All three signer keys generated, backups in distinct locations per `SIGNER_POLICY.md`.
- [ ] Multisig address computed and EVM-mapped form recorded via `pallet_revive.map_account()`.
- [ ] Testnet deploy transferred ownership to multisig.
- [ ] `verify_deployment.sh testnet` passes.
- [ ] Pause/unpause from pauser EOA rehearsed.
- [ ] Admin rotation from multisig rehearsed end-to-end.
- [ ] Recovery playbook dry-run for each lost-key scenario.

### Mainnet parameters

- [ ] `DAILY_OUTFLOW_CAP = 250 DOT`.
- [ ] `BORROW_CAP = 25 DOT`.
- [ ] `MIN_COLLATERAL_RATIO_BPS = 20000` (200%).
- [ ] `DEFAULT_CLAIM_STAKE_BPS = 1000` (10%).
- [ ] `REJECTION_SKILL_PENALTY = 10`, `REJECTION_RELIABILITY_PENALTY = 25`.
- [ ] `DISPUTE_LOSS_SKILL_PENALTY = 35`, `DISPUTE_LOSS_RELIABILITY_PENALTY = 60`.
- [ ] Owner, pauser, verifier, arbitrator addresses final and copied to private deploy env.

### Documentation

- [ ] `THREAT_MODEL.md` published.
- [ ] No-token statement linked in README and docs root.
- [ ] Week-12 gate thresholds and diagnostic order documented internally.
- [x] Reason-code registry published in `docs/DISPUTE_CODES.md` or equivalent.
- [ ] Phase 0 -> Phase 1 -> Phase 2 arbitration migration triggers documented publicly.

### Dispute flow

- [ ] `setArbitrator(pascalAddr, true)` called from multisig.
- [ ] Hardware wallet provisioned for arbitrator key, separate from multisig cold key.
- [ ] `POST /disputes/:id/verdict` and `POST /disputes/:id/release` wired to call `EscrowCore.resolveDispute`.
- [ ] Dispute reasoning content stored under `/content/:hash`.
- [ ] Operator app dispute queue surfaces `disputedAt` and SLA countdown.
- [ ] Dispute notification path live.
- [ ] Public migration commitment to Phase 1 by month 6 or first 50 disputes.

### Async XCM

- [ ] Backend SCALE assembler shipped.
- [ ] HTTP `/account/allocate` and `/account/deallocate` accept intent only, not raw bytes.
- [ ] Backend mirrors `previewRequestId(context)` and appends `SetTopic(requestId)`.
- [ ] `XcmWrapper.queueRequest` SetTopic validation check live.
- [ ] Chopsticks experiment confirms Bifrost preserves SetTopic on reply-leg, or fallback chosen and documented.
- [ ] Async XCM staging proof captured per `ASYNC_XCM_STAGING.md`.

## 13. Reconciliation log

### v1.4 - yield strategy portfolio model

1. Replaced the single-vDOT wallet framing with a yield-strategy portfolio model behind the existing `XcmVdotAdapter` pattern.
2. Locked the v1 default to moderate auto-allocation into Bifrost vDOT: single-hop XCM, single vendor surface, and the simplest correlation path.
3. Scoped Hydration GDOT as an opt-in v2 composite-yield adapter, never an auto-allocation default.
4. Scoped Hydration money-market borrowing as the v2 direction for replacing native flat balance-sheet lending once liquidation mechanics become necessary.
5. Added Hydration GDOT and Hydration money-market borrow facility to deferred items with triggers and rationale.
6. Updated the worker-wallet positioning line to match the portfolio framing.

### v1.3 - arbitration evolution path; on-chain dispute flow grounded

1. Corrected arbitrator authority to `TreasuryPolicy.arbitrators` mapping with `setArbitrator(address, bool)`.
2. Corrected slash split to 50/50 poster/treasury, zero to arbitrator at launch.
3. Added arbitration evolution path: Phase 0 human, Phase 1 supervised LLM, Phase 2 tiered agent quorum, Phase 3 permissionless tier.
4. Added separate eligibility ladders for internal jobs and arbitration.
5. Documented Phase 0 dispute process grounded in `EscrowCore.openDispute` and `resolveDispute`.
6. Added verifier accountability via public trail.
7. Added arbitration safety contract changes: dispute deadline, 7-day `DISPUTE_WINDOW`, `autoResolveOnTimeout`, `disputedAt`.
8. Added reason-code registry.
9. Added Phase 1/2/3 arbitration roadmap items.
10. Added positioning lines for tiered access and data-driven migration.
11. Added dispute-flow backend wiring checklist.
12. Added Phase 0 arbitrator setup items.

### v1.2 - XCM correlation gate, async lane scoping

1. Added `XcmWrapper.queueRequest` SetTopic validation as a v1.0.0-rc1 contract change.
2. Added async XCM untrusted input threat model entry.
3. Chose SetTopic = requestId as the correlation primitive; Bifrost reply-leg preservation remains empirical.
4. Documented current async XCM lane reality: scaffolded only, raw bytes accepted, no SetTopic anywhere in codebase.
5. Replaced placeholder async XCM checklist with concrete assembler and observer items.

### v1.1 - reconciliation against deployed reality and operational docs

1. Split claim stake from claim fee.
2. Reframed borrow-to-stake as durable post-onboarding flow.
3. Added vDOT strategy as wallet-as-earning-account framing.
4. Distinguished arbitrator role from peer-verifier re-review.
5. Moved disclosure events to existing session contract, not new `DisclosureLog`.
6. Removed `VerifierRegistry` as the target new-contract architecture; replaced with extension to existing verifier mapping.
7. Confirmed `DiscoveryRegistry` as the only genuinely new target contract.
8. Folded in references to mainnet parameters, multisig, signer policy, async XCM staging, and native XCM observer docs.
9. Added native XCM observer correlation gate as v1.x prerequisite.
10. Added vDOT positioning line.
