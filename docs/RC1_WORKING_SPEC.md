# Averray — Working Spec (v1.0.0-rc1)

**Status:** Reconciled with deployed reality and operational docs
**Spec version:** 1.10 (repository sync after Slice 9; v1.9 verification corrections imported, backend SCALE assembler and SetTopic wrapper validation marked shipped, TOKEN_ADDRESS wording aligned with no-native-DOT-precompile correction)
**Owner:** Pascal

---

## Summary

Averray is trust infrastructure for software agents on Polkadot Hub (Asset Hub EVM). The platform runs as a marketplace take-rate model with no platform token, sustained by fees and structurally honest receipts. Reputation is bootstrapped by funding agent contributions to public OSS and Wikipedia where the upstream merge itself is the verdict — no posters required to seed the trail. Source of truth lives on-chain (commitments, identity, payouts) with hashes binding to off-chain content. Idle wallet balance earns vDOT yield via async XCM to Bifrost, making worker wallets durable earning accounts. Sustainability target is fee-funded operations within 6–12 months of public launch.

---

## 1. Business model

### Locked

- **Marketplace take rate (Model A).** Revenue scales with settled-escrow GMV.
- **Polkadot Hub (Asset Hub EVM) as the production target.** Cheap tx, EVM compatibility, XCM for cross-chain capital. DOT exposed to EVM contracts via foreign-asset wrapping or XCM multilocation reference, NOT via a native DOT precompile (no such precompile exists; previously-stated claim was incorrect — see `MULTISIG_SETUP.md §5` `TOKEN_ADDRESS` field for downstream impact). Architectural fit, not a beachhead.
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

**Worked examples (post-onboarding):**

| Job tier | Payout | Stake (10%) | Fee | Total locked at claim | Net cost on success |
|---|---:|---:|---:|---:|---:|
| Light | $1 | $0.10 | $0.05 (floor) | $0.15 | $0 |
| Substantive | $5 | $0.50 | $0.10 (2% binds) | $0.60 | $0 |
| Substantive | $7 | $0.70 | $0.14 | $0.84 | $0 |

Working agent pays nothing net. Bad actors fund both reputation penalties and verifier compute on every failed attempt.

### Onboarding flow (durable, not transitional)

A new agent never needs upfront DOT to start working:

1. **SIWE sign-in** → worker wallet exists
2. **First 3 jobs claimed without stake or fee.** Both waived. Agent earns DOT from these jobs into the wallet's `AgentAccountCore` balance.
3. **Job 4 onward, two paths converge:**
   - Use accumulated DOT from jobs 1–3
   - Or borrow against the per-account `BORROW_CAP = 25 DOT` to bridge stake on a higher-tier job
4. **On settlement,** payout repays any outstanding borrow first; surplus settles to wallet balance and (optionally) into the vDOT strategy

Borrow-to-stake is the durable model, not a v2 item. It exists in the contract suite already (`BORROW_CAP = 25 DOT`, flat per-account, current launch profile).

### Wallet as earning account: yield strategy portfolio

Idle DOT in `AgentAccountCore` can be allocated into yield strategies via the async XCM lane. Agents earn yield between jobs. This is real stickiness — switching off Averray means unwinding a yield position, not just changing a default.

The platform treats yield strategies as a **portfolio**, not a fixed choice — different agents have different risk tolerances, and the Polkadot DeFi landscape evolves faster than launch-time architecture should lock in. The existing `XcmVdotAdapter.sol` pattern already isolates this concern; new strategies ship as new adapters behind the same `XcmWrapper` surface.

**v1 default: moderate auto-allocation to vDOT (Bifrost).**
- Idle balance above a threshold auto-allocates to vDOT via single-hop XCM to Bifrost.
- Yield: ~5–6% APR base from native staking rewards (post-2026 Bifrost tokenomics reset; verify current Bifrost docs before launch — yields shift with Polkadot inflation policy and Bifrost incentive structure).
- Single vendor (Bifrost), single XCM hop, single correlation primitive (SetTopic preserved on reply-leg, pending Chopsticks confirmation).
- Lowest vendor surface, well-understood risk.
- Conservative-by-default for trust infrastructure: the platform is sensible by default but doesn't ceiling agents who want more.

**v2 strategy: Hydration GDOT (composite yield).**
- New `HydrationGdotAdapter` alongside `XcmVdotAdapter`. Same `XcmWrapper` surface; different backend SCALE assembler; different observer correlation logic.
- Yield: targeting ~15–20% APR from leveraged composition of vDOT staking + aDOT lending + vDOT/aDOT pool trading fees + Hydration/Polkadot treasury incentives. Real yield depends on leverage ratio chosen and prevailing market conditions.
- Tradeoffs: doubled vendor surface (Hydration + Bifrost), multi-hop XCM (Hub → Hydration → Bifrost → Hydration → Hub), exposure to Hydration's drifting-peg mechanism, Omnipool pricing, and HDX governance.
- Opt-in only. Agents explicitly choose this strategy; never auto-allocated.

**Decision principle for the portfolio:**
The marketing line *"Your worker wallet earns between jobs"* doesn't require maximum yield to be true. ~5–6% from vDOT alone meaningfully beats CEX yield (0.5–3%) and most bank savings rates; the marginal benefit of GDOT over vDOT isn't worth doubling vendor surface and complicating XCM correlation at launch. Ship vDOT first, validate the correlation gate, then add GDOT as an upgrade path for agents who want it.

**Hydration money market for borrow facility (v2):**
The existing `BORROW_CAP = 25 DOT per account` runs on Averray's own balance sheet — the platform is the lender. When liquidation mechanics ship (currently a v2 deferred item), strongly consider routing the borrow facility through Hydration's money market instead of building it natively. That changes `BORROW_CAP` from "Averray's exposure ceiling" to "max LTV against agent's GDOT/aDOT collateral on Hydration." Cleaner risk model: Averray no longer carries lender-of-last-resort exposure, borrow caps scale with actual collateral rather than a flat number, and liquidation mechanics already exist and are battle-tested. Reputation-weighted credit becomes a small additional reservoir on top of Hydration's collateral-based lending, rather than the entire borrow primitive.

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

---

## 10. Deferred / open items

Tracked, not in v1.0.0-rc1:

- **Counterparty access during disclosure window.** Adds a fourth visibility input. Ship in v1.1.
- **Multi-verifier for high-value jobs.** Quorum signing. v2.
- **Verifier key rotation policy.** Concrete cadence and mechanism. Document in `THREAT_MODEL.md` as an explicit gap.
- **Phase 2 storage migration: real choice between Bulletin Chain and Crust.** Both are IPFS-compatible content-addressed stores; both work with the spec's content-addressing-from-day-one discipline. Bulletin Chain's structural fit was overstated in earlier spec versions — verification against [official docs](https://docs.polkadot.com/reference/polkadot-hub/data-storage/) showed fixed ~2-week retention with mandatory renewal (not configurable per blob), Root-origin authorization (mainnet model still being finalized), and renewal generating new `(block, index)` pairs requiring persistent state tracking. Crust's per-byte fees forever look more expensive but operationally simpler. Don't lock the choice now — defer until Averray's actual content volume, OpenGov receptivity, and Bulletin mainnet authorization model are known. See the verification ledger for full source quotes and operational implications.
- **Subjective job types** (translations, summaries, reports). Require LLM-as-judge verifier; push the verifier-cost-as-%-of-payout invariant. Re-price before introducing.
- **Backend SCALE assembler hardening.** The first server-controlled assembler is shipped in `mcp-server/src/blockchain/xcm-message-builder.js`: HTTP rejects caller-supplied raw `destination`/`message`/`nonce`, backend assigns nonce, mirrors `previewRequestId(context)`, assembles XCM v5 bytes from strategy intent, appends `SetTopic(requestId)` as the last instruction, and submits assembled bytes to `XcmWrapper`. It no longer carries scaffolded vDOT message defaults or raw message-prefix config. Remaining work before vDOT mainnet is empirical staging against Bifrost deposit, withdraw, and failure flows.
- **Native XCM observer correlation gate.** Depends on the assembler. With SetTopic baked into every outbound message, correlation works *if* Bifrost's reply-leg XCM preserves the original SetTopic on its return to Hub. This is the empirical question the Chopsticks experiment validates. Three possible outcomes: **(a)** SetTopic preserved → match return-leg by topic, ship cleanly. **(b)** Not preserved but Hub credit-to-sovereign events are unambiguous → per-strategy serialized dispatch queue (one outbound XCM per strategy in flight at a time), match by sequential order. **(c)** Concurrency required and no preservation → amount-perturbation fallback (sub-Planck dust per request, last resort). v1.x prerequisite for production-volume async strategies.
- **Liquidation mechanics for borrow facility.** Current `BORROW_CAP = 25 DOT` flat per account; no liquidation. Conservative `MIN_COLLATERAL_RATIO_BPS = 20000` (200%) holds the line until liquidation ships. v2 work.
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
- **Hydration GDOT strategy adapter (v2).** New `HydrationGdotAdapter` alongside `XcmVdotAdapter`, same `XcmWrapper` surface. Composite yield (vDOT + aDOT + pool fees + incentives), targeting ~15–20% APR depending on leverage and market conditions. Multi-hop XCM (Hub → Hydration → Bifrost → Hydration → Hub) requires extending the correlation gate verified for single-hop Bifrost. Opt-in only, never auto-allocated. Ship after the v1 vDOT strategy is empirically stable.
- **Hydration money market borrow facility (v2).** Replace native `BORROW_CAP = 25 DOT` flat-balance-sheet model with collateralized borrowing against agent-held GDOT/aDOT on Hydration's money market. Eliminates Averray's lender-of-last-resort exposure, scales borrow with actual collateral, reuses Hydration's audited liquidation mechanics. Triggers when liquidation mechanics for the native borrow facility would otherwise need to be built — route through Hydration instead.

---

## 11. Marketing / positioning lines

Short, linkable, defensible. Drop into docs root and README:

- *"Averray is a blockchain product, not a token product."*
- *"No token. No airdrop. No points program."*
- *"Receipts, not vibes."*
- *"Failed attempts are private for 6 months, then join the public record."*
- *"The first thing Averray sells is trust, not yield."*
- *"Your worker wallet earns between jobs."* (yield-strategy portfolio positioning; v1 default is vDOT auto-allocation)
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
- [ ] `DAILY_OUTFLOW_CAP = 250 DOT`
- [ ] `BORROW_CAP = 25 DOT`
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
- [x] Backend SCALE assembler shipped (`mcp-server/src/blockchain/xcm-message-builder.js` or equivalent)
- [x] HTTP `/account/allocate` and `/account/deallocate` accept intent only, not raw `destination`/`message` bytes
- [x] Backend mirrors `previewRequestId(context)` formula and appends `SetTopic(requestId)` to every assembled XCM
- [x] `XcmWrapper.queueRequest` SetTopic-validation check live (ships in v1.0.0-rc1 redeployment)
- [ ] Chopsticks experiment confirms Bifrost preserves SetTopic on reply-leg, *or* fallback strategy chosen and documented
- [ ] Async XCM staging proof captured per `ASYNC_XCM_STAGING.md`

---

## 13. Reconciliation log

For traceability.

### v1.10 (repository sync after Slice 9)

1. Imported the post-verification spec book into the repository as `docs/RC1_WORKING_SPEC.md` and added the companion `AVERRAY_VERIFICATION_LEDGER.md` plus `FRAMEWORK_AGENT_HANDOFF.md`.
2. Marked Slice 8/9 async XCM foundations as shipped: `XcmWrapper.queueRequest` validates `SetTopic(requestId)`, backend rejects caller-supplied raw XCM bytes, and `mcp-server/src/blockchain/xcm-message-builder.js` assembles server-controlled request payloads.
3. Moved backend SCALE assembler from "not built" framing to follow-up hardening/staging framing. The remaining vDOT-mainnet blocker is the native XCM observer correlation gate and staging evidence.
4. Corrected the lingering Hydration GDOT deferred-yield line from `18–25%` to `~15–20%` so it matches the v1.9 verification correction.
5. Aligned deploy/runbook wording around `TOKEN_ADDRESS`: no native DOT precompile is assumed; testnet/mainnet must provide an approved ERC20 asset precompile or a deliberately chosen test token until the native-DOT representation question is resolved.

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

## 14. Parameter tunability and experimentation discipline

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
| `DAILY_OUTFLOW_CAP` | 250 DOT |
| `BORROW_CAP` | 25 DOT per account |
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

*Last updated: 2026-04-25*
