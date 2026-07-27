# Preflight onboarding-waiver parity handback

## Built

- Added one shared `resolveClaimEconomicsDecision` function with the semantics
  "what will `claimJobFor` charge this wallet if it claims now?"
- Routed both `PlatformService.getClaimEconomicsPreview` and
  `JobExecutionService.claimJob` precompute through that function. The catalog preflight and
  recommendation paths continue to inherit the platform preview through
  `JobCatalogService.resolveClaimEconomics`.
- Added a strict gateway decision-state read that distinguishes:
  - an existing current-layout escrow and its live
    `onboardingWaiverEligibleJobs` mapping;
  - an unknown current-layout escrow; and
  - a legacy-layout escrow.
- Existing current-layout escrows use `previewClaimEconomics` as their base truth. When the
  catalog flag is true and the mapping is false, the shared function applies the exact
  eligibility sync that `ensureJob` will perform and recomputes waiver status from the
  contract's `claimNumber` and the strictly-read policy count.
- Unknown current-layout escrows never call `previewClaimEconomics`. They compute from the
  catalog eligibility flag, the strict chain worker count, the strict waiver-policy limit, and
  the existing stake/fee inputs.
- Legacy layouts always compute with waiver eligibility false. They do not infer a fresh worker
  from a missing `workerClaimCount` selector.
- `getClaimEconomicsConfig({ requireWaiverInputs: true })` no longer converts a failed
  `onboardingWaiverClaimCount` read to zero. `getWorkerClaimCount` now errors when its selector is
  unavailable instead of returning zero.
- The claim path retains the post-`ensureJob` contract preview as final authority. A
  current-layout preview failure now fails the claim instead of silently using a projection.
  Legacy preview absence keeps the standing fallback because changing the legacy session path is
  a packet non-goal.
- Added an invariant probe at claim time. Any difference in stake, fee, basis points, waiver
  status, claim number, or total lock emits an error-level
  `claim_economics_prediction_mismatch` record containing both values and per-field differences.

Packet-bearing base: `732465344c20098b00f6ca79051cfd3c0609bc6d` (PR #834).
Final branch base: `ac1ba1898278fca590f2df2ac1c50c419487acea` (current `origin/main`,
including the unrelated ops-only PR #835).

## Packet test mapping

1. **Fresh-wallet parity**
   - File: `mcp-server/src/core/platform-service.test.js`
   - Case: `preflight and claim both waive a fresh wallet after the guaranteed eligibility sync`
   - Evidence: current-layout escrow exists, catalog eligibility is true, mapping is false,
     worker count is zero, policy limit is three. Preflight and claim both return
     `claimEconomicsWaived=true`, `claimStake=0`, and `totalClaimLock=0`.
2. **Mapping true / catalog flag false**
   - File: `mcp-server/src/core/platform-service.test.js`
   - Case: `preflight trusts an existing on-chain waiver when the catalog flag is false`
   - Evidence: preflight returns the contract's waived result verbatim and the subsequent claim
     reports the same zero lock.
3. **Degraded waiver-policy read**
   - File: `mcp-server/src/core/platform-service.test.js`
   - Case: `preflight fails closed when the onboarding-waiver policy read fails`
   - Evidence: the request rejects, returns no confident economics object, and records zero
     contract-preview calls for the unknown escrow.
   - Gateway pin: `getClaimEconomicsConfig surfaces a required onboarding-waiver policy read
     failure` in `mcp-server/src/blockchain/gateway.test.js`.
4. **Legacy / missing worker-count selector**
   - File: `mcp-server/src/core/platform-service.test.js`
   - Case: `legacy layout never advertises an onboarding waiver without a worker claim selector`
   - Evidence: `claimEconomicsWaived=false` with the full projected lock.
   - Gateway pin: `getWorkerClaimCount refuses a missing contract selector instead of fabricating
     zero` in `mcp-server/src/blockchain/gateway.test.js`.
5. **Exhausted budget**
   - File: `mcp-server/src/core/platform-service.test.js`
   - Existing case retained: `preflight uses chain worker claim count for claim economics in
     blockchain mode`
   - Evidence: prior count three produces `claimNumber=4`,
     `claimEconomicsWaived=false`, and the full stake/fee lock.

Additional invariant-probe pin:

- File: `mcp-server/src/core/job-execution-service.test.js`
- Case: `claimJob logs an invariant error when the shared prediction differs from contract
  authority`
- Evidence: the error-level probe contains the differing prediction and authority, while the
  persisted session uses the contract result.

## State-table review

| Packet state | Implementation result |
|---|---|
| Current layout, escrow exists, mapping matches catalog | Contract preview verbatim |
| Current layout, escrow exists, flag true / mapping false | Contract preview adjusted for the guaranteed eligibility sync using contract `claimNumber` plus strict policy limit |
| Current layout, escrow exists, flag false / mapping true | Contract preview verbatim; no reverse sync |
| Current layout, escrow absent | Strict local computation; no contract preview |
| Current layout, failed policy or worker-count read | Error; no fabricated waiver or stake |
| Legacy layout | Local full economics with waiver eligibility forced false |
| Non-chain/local mode | Existing local session-count computation unchanged |

There is no deviation from the packet state table.

## Gates

Dependency installation used the committed lockfile and produced no tracked dependency or lock
change.

```text
$ node --test src/core/platform-service.test.js
tests 38
pass 38
fail 0

$ node --test src/core/job-execution-service.test.js
tests 26
pass 26
fail 0

$ node --test src/blockchain/gateway.test.js
tests 62
pass 62
fail 0

$ npm --workspace mcp-server test
tests 1093
pass 1092
fail 1
```

The single first-run failure was unrelated host-state noise:
`collectHostDiagnostics reports process, disk, and clean recommendations` expected the clean
"read-only" recommendation, but the test host's temporary volume was above the default disk
warning threshold and correctly produced the disk-space recommendation instead. The failure
reproduced in isolation and no host-diagnostics code was changed.

The full suite was rerun with only those diagnostic thresholds placed above 100 so host disk
pressure could not select the unrelated warning branch:

```text
$ HOST_DISK_WARN_PERCENT=101 HOST_DISK_CRITICAL_PERCENT=101 \
    npm --workspace mcp-server test
tests 1093
suites 0
pass 1093
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 3120.388958
```

`git diff --check` is clean. The installed workspace dependencies also removed the packet's known
clean-worktree `@aws-sdk/*` noise, so the gateway and full backend suites ran rather than being
waived. The three focused suites and the final full suite above were rerun after rebasing onto
current `origin/main`.

## Truth-boundary review

The packet-requested `truth-boundary-review` skill was unavailable in this implementation
session. A manual equivalent review checked:

- both preflight and claim precompute have exactly one call to the shared resolver;
- current existing escrows cannot use local economics after a failed contract preview;
- unknown escrows cannot call the contract preview that reverts `UnknownJob`;
- waiver-capable unknown escrows cannot compute without a real worker count and policy limit;
- catalog false / mapping true never triggers reverse synchronization;
- post-ensure contract economics overwrite the prediction; and
- the HTTP preflight projection exposes no new optimistic fallback.

Both truth directions are pinned: the implementation neither advertises a waiver from an
unreadable/missing current-layout input nor advertises stake when the existing contract preview
waives it.

## Decisions and rationale

1. **Decision state is one explicit gateway method.** Keeping layout, existence, and mapping in a
   single read contract prevents callers from reconstructing incompatible partial states.
2. **Strict policy reading is opt-in for waiver decisions.** Other operational status surfaces
   retain their standing best-effort behavior; only the authoritative preflight/claim path
   refuses the silent zero.
3. **Legacy prior claim count remains zero for the local projection.** Waiver eligibility is
   forced false, so the count cannot change the charged stake or fee. This preserves the previous
   missing-selector behavior without allowing it to fabricate a waiver.
4. **Current-layout final preview failures propagate.** Treating the post-sync contract preview as
   final authority is incompatible with silently retaining a local prediction.
5. **The branch starts from current main.** The requested rung-3 work had already landed through
   squash-merged PR #831 and its remote branch was deleted; PR #834 then placed this packet on
   main. The implementation was finally rebased onto `ac1ba18`, whose only intervening change was
   the unrelated ops-only PR #835.

## Non-goals and open work

- No two-way mapping un-sync was added.
- No `/jobs/estimate-reward` documentation or logic changed.
- No separate legacy-layout session behavior was added beyond the state table's mandatory
  never-waive decision.
- `claimEconomicsWaiverScope`, `claimEconomicsWaivedAtClaim`, the POST-preflight 405, and
  `starter-coding-002` remain intact.
- Production live verification remains a post-deploy operator step; no production access or
  mutation was performed from this branch.
