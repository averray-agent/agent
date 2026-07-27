# Packet: Preflight ⇄ Claim onboarding-waiver parity

**Status:** spec ready — routed as a **Codex handoff packet** (Pascal, 2026-07-28); implement on top of `codex/blind-agent-rung3-fixes`; Claude gates the handback
**Origin:** 2026-07-27 day-one blind-agent validation run on production mainnet; logged as out-of-scope item 1 in PR #830.
**Author:** Claude (architect/gate). **Date:** 2026-07-28.

## Defect

`GET /jobs/preflight` returned `claimEconomicsWaived: false` + a nonzero `claimStake` for a job marked
`onboardingWaiverEligible`, yet claiming then applied a full waiver. The platform tells agents preflight is
authoritative (`discovery-manifest.js:172`: "curated jobs marked onboardingWaiverEligible waive the claim
stake — so a fresh unfunded wallet can claim, submit, and earn from zero"; `/jobs/preflight` is the advertised
pre-claim check). An agent that trusts preflight walks away from jobs it could claim for free — or, in the
reverse direction, budgets zero for a claim that will charge stake. Both directions are truth-boundary
violations on a documented-authoritative surface.

## Root cause (structural, proven from code + live chain)

Preflight and claim decide the waiver from **two different sources of truth**, with no invariant tying them:

| | waiver decided by | code |
|---|---|---|
| `GET /jobs/preflight` | local mirror: catalog `job.onboardingWaiverEligible` + `gateway.getWorkerClaimCount` + `gateway.getClaimEconomicsConfig` → `computeClaimEconomics` | `job-catalog-service.js:363` → `resolveClaimEconomics:581` → `platform-service.js:1259` (`getClaimEconomicsPreview`) |
| `POST /jobs/claim` | the contract: local precompute, then **overridden** by `escrow.previewClaimEconomics(wallet, jobId)` after `ensureJob` syncs the on-chain mapping; `claimJobFor` then charges per contract state regardless | `job-execution-service.js:183-212`; `gateway.js:968` |
| contract formula | `waived = onboardingWaiverEligibleJobs[jobId] && workerClaimCount[worker]+1 <= policy.onboardingWaiverClaimCount()` | `EscrowCore.sol:842-843` |

Divergence generators, all live today:

1. **One-way, claim-time-only sync.** `gateway.ensureOnboardingWaiverEligibility` (`gateway.js:1051`) returns
   early unless `job.onboardingWaiverEligible === true` — it only ever sets the chain mapping to `true`, never
   clears it, and only runs inside the claim path. Catalog flag and chain mapping can disagree indefinitely in
   both directions (flag withdrawn → mapping stays true → claim waives while preflight says staked; flag added
   but job already on-chain unsynced until next claim attempt).
2. **Silent fallbacks in the mirror.** `getClaimEconomicsConfig` (`gateway.js:404`) swallows a failed
   `onboardingWaiverClaimCount()` read into `0` → the mirror reports `waived:false` for everyone while the
   contract keeps waiving (blanket day-one symptom shape). `getWorkerClaimCount` (`gateway.js:425`) returns `0`
   when the selector is missing → mirror over-waives (the dangerous direction: promises a waiver the contract
   won't grant).
3. **Legacy-layout session lie (adjacent, claim-side).** On a layout without `previewClaimEconomics`, the
   override's `.catch(() => claimEconomics)` (`job-execution-service.js:211`) keeps the local `waived:true`
   in the session while the legacy contract charges full stake.
4. Contract `previewClaimEconomics` **reverts `UnknownJob`** for escrows not yet created
   (`EscrowCore.sol:252`; jobs are created lazily at first claim by `ensureJob`) — so preflight cannot simply
   call the contract view; it must *simulate the claim-time decision* including the sync `ensureJob` will
   perform.

**Live mainnet evidence (cast, 2026-07-28, chainId 420420419):**
`TreasuryPolicy(0x226F…AF20).onboardingWaiverClaimCount()=3`, `defaultClaimStakeBps()=1000`, `claimFeeBps()=200`
(reads healthy). `EscrowCore(0x9cCd…C035).onboardingWaiverEligibleJobs(keccak("starter-coding-001")=0x3d3002bb…45e5)
= true` with job state 6 (Closed) — a permanently-true mapping outliving the job, while the catalog record is
being retired (Codex branch, below). The split-brain state class is not hypothetical.

The exact day-one trace (which input diverged for the blind agent's wallet at probe time) was not
reconstructed — the run transcript isn't in `agent-harness`. The structural class above is proven regardless;
candidates are (2) transient policy-read → 0, catalog-flag drift on the runtime record, or claim-count
movement via `handleClaimTimeout` decrements (`EscrowCore.sol:899-902`) between probe and claim.

## Interaction with Codex's in-flight branch

`codex/blind-agent-rung3-fixes` (af03df2, 6f498d2 — unmerged) touches the same surfaces: adds
`claimEconomicsWaiverScope: "next_claim_projection"` to preflight and `claimEconomicsWaivedAtClaim` /
`"claim_time"` to sessions, 405s `POST /jobs/preflight`, retires `starter-coding-001` → adds
`starter-coding-002` (0.2 USDC, waiver-eligible), extracts `bootstrap-jobs.js`. **Labels disclose that
preflight is a projection; they do not make the projection faithful.** This packet layers on top: keep the
labels, make the projection equal the claim-time decision whenever its inputs are readable. Implementation
must rebase on (or fold into) that branch to avoid conflicts in `job-catalog-service.js` /
`platform-service.test.js`.

## Fix contract

One decision function, used by **both** preflight and the claim path's precompute — semantics: *"what will
`claimJobFor` charge this wallet if it claims now?"*

| state | preflight must return |
|---|---|
| chain mode, escrow exists on-chain | contract `previewClaimEconomics(wallet, chainJobId)`, adjusted for the guaranteed pre-claim sync: if catalog flag `true`, mapping `false`, current layout → recompute `waived` with `eligible=true` using the contract's `claimNumber` and policy count (because `ensureJob` will set the mapping before economics lock). Flag `false` + mapping `true` → contract answer verbatim (claim will waive; report it). |
| chain mode, escrow not yet created | local compute with `eligible = catalog flag && layout supports waivers`, `priorClaimCount = gateway.getWorkerClaimCount(wallet)`, policy count from chain — **no silent-zero fallbacks**: a failed policy/count read must fail the preflight request (or mark the economics fields explicitly unavailable), never fabricate `waived:false` or `waived:true`. |
| legacy layout (no waiver support) | never report `waived:true`, whatever the catalog flag says. |
| non-chain (local/demo) mode | current local behavior unchanged. |

Claim path: keep the post-`ensureJob` contract override as the final authority, and **log loudly (invariant
probe) when the shared function's prediction ≠ the contract's answer** — that mismatch is the bug class
recurring. `recommendJobs` (`job-catalog-service.js:312`) inherits the shared function automatically via
`resolveClaimEconomics`.

Truth boundary, both directions: never advertise a waiver the contract won't grant; never advertise a stake
the contract won't charge. Degraded reads surface as degraded — not as a confident wrong number. Run the
`truth-boundary-review` skill on the implementation diff before merge.

## Regression tests (required)

1. **Parity, fresh wallet (the task's named test):** chain-mode mock gateway, job `onboardingWaiverEligible:
   true`, mapping unset, `workerClaimCount=0`, policy count 3 → `preflightJob(...).claimEconomicsWaived === true`
   and `=== claimJob(...).claimEconomicsWaived`; `claimStake`/`totalClaimLock` equal (0) on both.
2. **Split-brain, mapping true / flag false:** mock chain mapping `true`, catalog flag `false`, escrow exists →
   preflight reports `waived:true` (matching what claim will do), not `false`+stake.
3. **Degraded read:** policy `onboardingWaiverClaimCount()` read fails → preflight does **not** return
   `waived:false` with full stake; it errors or marks economics unavailable.
4. **Dangerous direction:** legacy layout / missing `workerClaimCount` selector → preflight never returns
   `waived:true`.
5. **Exhausted budget stays correct:** existing `platform-service.test.js:505` (claimNumber 4 → not waived)
   keeps passing.

## Acceptance gate

Unit tests above green; full `mcp-server` suite green modulo the known worktree dep noise (`@aws-sdk/*`);
truth-boundary-review clean; live verify on prod after deploy: fresh-wallet agent JWT →
`GET /jobs/preflight?jobId=starter-coding-002` shows `claimEconomicsWaived:true, totalClaimLock:0`, then an
actual claim session shows the same; a wallet with ≥3 chain claims shows `false` + stake on both.

## Non-goals (adjacent findings, route separately)

- **Two-way mapping sync** (clearing `onboardingWaiverEligibleJobs` when the catalog withdraws a flag) changes
  claim-time behavior — Codex economics decision, separate change.
- Legacy-layout session lie (generator 3) — claim-side fix, same territory.
- `/jobs/estimate-reward` is documented as "net-reward after fees, waivers, and stake"
  (`discovery-manifest.js:53`) but `estimateNetReward` (`job-catalog-service.js:458`) folds neither fees nor
  waivers for non-native assets — doc or logic needs aligning.
