# Spec Audit - 2026-05-13

This audit reconciles the current spec and roadmap after the recent framework,
USDC, discovery, secrets, product-proof, lineage, and event-log work.

Primary source of truth:

- [AVERRAY_WORKING_SPEC.md](./AVERRAY_WORKING_SPEC.md) - current v2.7 product
  and launch spec.
- [CORE_FRAMEWORK_ROADMAP.md](./CORE_FRAMEWORK_ROADMAP.md) - framework
  implementation tracker.
- [RC1_IMPLEMENTATION_PLAN.md](./RC1_IMPLEMENTATION_PLAN.md) - historical rc1
  slice plan that still tracks several contract and native-XCM gates.
- [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) - live launch-readiness
  gate.
- [SECRETS_MIGRATION.md](./SECRETS_MIGRATION.md) - active secret-management
  migration plan.

## Executive Summary

The framework has moved from "can the platform do this?" into "can we prove the
live system, controls, and evidence gates are coherent enough for external
agents?"

The major plan upgrade is that v1 is now explicitly **USDC-only settlement**.
Yield, swap-and-stake, and vDOT wallet earnings are deferred until after the
week-12 work primitive gate and native-XCM evidence gate. That means public
positioning and launch checks should lead with trusted work, portable identity,
and verifiable receipts, not yield.

The second plan upgrade is the **Micro / Standard / Substantive** job model.
The bootstrap objective is now receipt density and reputation depth, not
higher per-job payouts.

The biggest operational risk area is not a product feature: launch readiness
still depends on proving the self-report and worker-loop paths under the hosted
stack. A recent `Configure SSH` deploy failure from the `VPS_SSH_KEY_OP`
cutover was fixed by the follow-up workflow hotfixes, the current
`Deploy Production` run is green after the 1Password-backed
SSH/basic-auth/admin-JWT cutovers, and the basic hosted smoke is green.

## What Is Done

### Trust And Work Core

- Job catalog, claim, submit, and verifier flow exist as working platform
  primitives.
- Verification results are stored with replay inputs, verifier config snapshot,
  config hash, config version, and handler version.
- Session transitions route through shared state-machine guards for the
  high-risk claim, submit, verification, expiry, and dispute paths.
- Duplicate submit and non-verifiable verifier callbacks fail closed before
  replacing submissions or settling.

### USDC Settlement Pivot

- v1 escrow asset is USDC, Trust-Backed Asset ID 1337, ERC20 precompile
  `0x0000053900000000000000000000000001200000`, 6 decimals.
- Launch-facing job sourcing, SDK defaults, badge/profile metadata, and
  recurring fallbacks default to USDC/6.
- The prior DOT/18 launch-scaling risk has been documented and largely closed
  for runtime-facing paths.
- Product-proof settlement now has a minBalance guard so sub-minBalance rewards
  do not fail with `SafeTransfer.TransferFailed`.

### Discovery And Public Trust Surface

- Public discovery is narrowed to a directory-safe shape.
- DiscoveryRegistry publish automation exists and can report `published` or
  `already_current`.
- Public no-token and launch trust docs are present.
- Public agent profile, badge/profile schema, and profile lookup surfaces have
  first-pass implementations.

### Observability

- Session and job timeline endpoints expose canonical envelopes with
  correlation, phase, source, topic, severity, job, session, wallet, and compact
  data fields.
- Timeline topics were standardized for the current platform event set.
- Event-bus entries now persist through the state store in memory and Redis,
  so `/events` and `/admin/jobs/timeline` can replay recent traces across
  process restarts.
- Backend and client surfaces support source, topic, phase, severity,
  correlation-id, and wallet filters.

### Recurring Jobs

- Scheduler runtime exists.
- Template runtime metadata is persisted.
- Finite reserve policy gates recurring fires.
- Admin status and operator controls expose recurring posture.
- Escrow-native/on-chain poster funding support is present.

### Sub-Jobs And Lineage

- Active workers can create sub-jobs from in-flight parent sessions.
- Parent/child indexes are persisted.
- Child runs are exposed on session detail surfaces.
- Delegation budget/depth fields exist.
- Child reward is reserved from the parent wallet.
- Operator and profile surfaces expose sub-contracting history.

### SDK And Integration Surface

- `sdk/agent-platform-client.js` is the first typed client surface.
- It wraps auth, list/recommend/preflight, claim, submit, resume, timeline,
  admin job creation, recurring fire, and status flows.
- Generated SDK types and shared validation types are now in place for the
  current API/schema source.

### Secrets And Deploy Control Plane

- Phase 2 secret migration has moved large parts of CI/deploy/runtime secret
  source of truth toward 1Password.
- ADMIN_JWT, VPS SSH key, and app basic-auth paths have recent cutover PRs.
- The latest `Deploy Production` workflow on `main` is green after those
  cutovers.
- Basic hosted smoke passes against public site, discovery manifest, protected
  operator shell, API health, onboarding, and indexer root/readiness/freshness.
- Blockchain key custody policy has been added to the secrets migration docs.

## What Is Still Left

### Immediate Ops Follow-Up

- Keep the `Configure SSH` failure mode closed by avoiding `${{ secrets.* }}`
  expressions inside `run: |` shell blocks.
- Run the product-proof gate variants that are not part of the normal deploy
  workflow.
- Use the production checklist, not this implementation roadmap, as the final
  go/no-go source for live launch.

### Launch-Blocking Or Launch-Relevant Gaps

- Run one complete hosted worker loop:
  discover -> sign in -> preflight -> claim -> submit -> verify -> badge/profile.
- Rerun the product-proof gate with worker-loop evidence.
- Finish bootstrap self-report scheduled email delivery and first-delivery
  proof.
- Confirm `/admin/status` with a live admin JWT reports async XCM watcher posture
  cleanly.
- Rehearse pauser pause/unpause from the hot key.
- Confirm current Postgres/Redis backups are restorable and run a restore drill.
- Fill named on-call ownership and alert destination for smoke-check failures.

### Native XCM / vDOT Gate

- Produce real Bifrost deposit, withdraw, and failure evidence captures with
  backend-built XCM messages.
- Run the Chopsticks/PAPI experiment for Bifrost reply-leg `SetTopic`
  preservation.
- If Bifrost preserves `SetTopic(requestId)`, promote topic matching as the
  correlation method.
- If not, document and validate the fallback before any production vDOT volume.
- Keep vDOT/yield public positioning gated until this proof exists and the
  week-12 work primitive gate passes.

### Schema-Native Jobs

- Align `docs/schemas/jobs/` with the runtime registry.
- Define first-party schemas for PR review findings, release readiness, issue
  triage, and docs drift audit.
- Enforce structured output validation before verifier execution and before
  helper workflows consume a claim/submit attempt.

### Verifier Replay Hardening

- Add `evidenceSchemaRef` or `submissionSchemaRef` where missing.
- Split verifier policy version from verifier config version when rules move
  beyond simple config data.
- Add handler-versioned replay fixtures before v2 verifier handlers.

### Dispute And Arbitration Flow

- Ensure the on-chain dispute path is complete for the current deployed
  contracts.
- Wire `POST /disputes/:id/verdict` and `/release` to the actual on-chain
  arbitration path if they still only record local receipts.
- Store arbitrator reasoning under `/content/:hash`.
- Surface `disputedAt`, SLA countdown, reason code, and on-chain tx state in
  the operator app.
- Provision/rehearse the phase-0 arbitrator key and notification path.

### Idempotency And Mutation Hardening

- Extend canonical request-hash receipts to async XCM admin routes.
- Add optional ingestion-run idempotency where callers need whole-run replay
  semantics.
- Reuse the receipt wrapper for future dispute and settlement routes.

### Timeline And Operator UX

- Fold funding, settlement, and dispute state into the same canonical trace.
- Standardize remaining producer topics/payloads.
- Add visible operator controls for source, topic, wallet, and correlation-id
  timeline filters.

### Capability Model

- Add operator grant/revoke flows for scoped service tokens or delegated
  wallets.
- Align public onboarding action requirements with the runtime auth-policy
  payload.
- Hide or disable frontend controls from `authPolicy.uiControls`.
- Emit audit events when capability grants change.

### Secrets Phase 2+ And Mainnet Custody

- Complete the remaining 1Password migration exit criteria:
  old plain-text GitHub/VPS secrets removed, tmpfs checks green, deploy logs
  clean, rotation test complete.
- Move smoke-channel secrets that are still outside 1Password.
- Delete legacy env/backups once the render path has proven stable.
- Keep signer private keys out of the Phase 2 success claim; Phase 3/KMS or
  equivalent custody work remains separate.

## Missed Or Upgraded Plan Items

1. `CORE_FRAMEWORK_ROADMAP.md` still referenced `RC1_WORKING_SPEC.md` as the
   roadmap boundary. The current source of truth is `AVERRAY_WORKING_SPEC.md`;
   `RC1_WORKING_SPEC.md` is historical context.
2. The current spec summary still implied wallet yield as if it were live. This
   audit updates it to reflect the v2.2 decision: v1 is USDC-only; yield is
   post-week-12 and post-native-XCM proof.
3. The bootstrap budget text still used the older two-tier job mix. This audit
   updates it to the Micro / Standard / Substantive model.
4. The framework roadmap had stale baseline language for recurring jobs,
   sub-job orchestration, and SDK maturity. These are now mostly complete
   framework areas, with future work concentrated in proof, UX, and operations.
5. The secrets migration has become a major live launch lane and should be
   tracked alongside the product roadmap, not treated as generic ops cleanup.
6. The launch checklist remains stricter than the implementation roadmap. Keep
   using `PRODUCTION_CHECKLIST.md` as the go/no-go surface.

## Polkadot Docs Check

Checked with the Polkadot docs MCP on 2026-05-13:

- ERC20 precompile docs still support the USDC Trust-Backed Asset path on
  Polkadot Hub.
- XCM precompile docs still describe the low-level `execute`, `send`, and
  `weighMessage` surface.
- Polkadot docs continue to point to PAPI and Chopsticks for XCM construction,
  replay, and dry-run validation.

That means the current Polkadot-specific plan still holds: USDC for v1 escrow,
and no production vDOT/yield claims until native XCM evidence proves the
correlation and settlement path.

## Recommended Next Queue

1. Complete the hosted worker-loop product-proof evidence gate.
2. Close bootstrap self-report scheduled email delivery.
3. Tighten schema-native jobs for first-wave job families.
4. Finish dispute/arbitration launch path.
5. Run the native XCM evidence pack captures.
6. Add visible timeline filters in the operator app.
7. Continue Phase 2+ secrets cleanup and signer custody hardening.
