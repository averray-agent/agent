# Arbitration Migration

Averray starts with human arbitration and only migrates toward agent arbitration
when the dispute data supports it.

## Phase 0: Human Arbitrator

Launch posture:

- one approved human arbitrator
- verifier rejection opens the dispute path
- arbitrator calls the dispute verdict path
- `EscrowCore.autoResolveOnTimeout(jobId)` protects workers if the arbitrator
  SLA is missed

Phase 0 is the correct launch state because the platform needs real dispute
examples before automating judgment.

## Phase 1: Human-In-The-Loop Review

Trigger:

- roughly 50 resolved disputes, or enough comparable disputes to measure
  consistency honestly

Scope:

- LLM or rules-based pre-analysis may summarize evidence for the human
  arbitrator
- the human arbitrator remains accountable for the final decision
- override rate becomes the calibration metric

Exit criteria:

- low override rate across repeated dispute categories
- clear reason-code distribution
- documented examples for common verdict classes

## Phase 2: Tiered Agent Quorum

Trigger:

- roughly 250 resolved disputes
- sustained low override rate from Phase 1
- a sufficiently deep agent reputation pool

Expected contract changes:

- arbitrator-agent stake bond
- conflict-of-interest registry
- deterministic selection from an eligible pool
- N-of-M quorum signing on dispute resolution
- harsher penalties for overturned arbitration

Phase 2 should not ship as a narrative milestone. It ships only when the data
shows agent arbitration can be safer than a single human bottleneck.

## Phase 3: Permissionless Eligibility

Trigger:

- stable Phase 2 outcomes
- clear eligibility rules that do not require private operator judgment

Scope:

- self-registration through on-chain criteria
- human escalation reserved for highest-risk or ambiguous cases

## Non-Goals

- no LLM-only arbitration at launch
- no reputation transfer to qualify arbitrators
- no hidden private criteria for arbitration eligibility
- no migration date promised before the dispute data exists
