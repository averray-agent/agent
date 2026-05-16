# Spec Audit - 2026-05-13

This audit reconciles the current spec and roadmap after the recent framework,
USDC, discovery, secrets, product-proof, lineage, event-log, schema-native,
idempotency, dispute, and async-XCM foundation work.

Primary source of truth:

- [AVERRAY_WORKING_SPEC.md](./AVERRAY_WORKING_SPEC.md) - current v2.9 product
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
- Finish operator-visible self-report proof through Hermes/operator reporting.
  The spec intent is durable operator visibility after deploy and on schedule,
  not branded email specifically. The remaining gate is operational:
  production deploys should keep `run_hermes_post_deploy=1`, scheduled Hermes
  ops-health and daily-brief routines should produce durable evidence, and
  `scripts/ops/check-hosted-stack.sh` should pass with
  `CHECK_BOOTSTRAP_INSTRUMENTATION=1` to prove the upstream-status and optional
  bootstrap self-report status surfaces are well-formed and sanitized. The
  Resend email path (`mcp-server/src/services/bootstrap-self-report-scheduler.js`
  and `POST /admin/bootstrap-self-report/send`) remains available as an
  optional branded transport, but its first-delivery gate is deferred until a
  verified sender domain is intentionally configured.
- Confirm `/admin/status` with a live admin JWT reports async XCM watcher posture
  cleanly.
- Rehearse pauser pause/unpause from the hot key.
- Confirm current Postgres/Redis backups are restorable and run a restore drill.
- Fill named on-call ownership and alert destination for smoke-check failures.

### Native XCM / vDOT Gate

- Treat backend-built XCM messages as the shipped foundation for the current
  Bifrost/vDOT strategy path: the assembler appends `SetTopic(requestId)`, the
  gateway routes strategy allocate/deallocate through intent payloads, and the
  wrapper validates the terminal SetTopic.
- Produce real Bifrost deposit, withdraw, and failure evidence captures from
  the hosted stack.
- Run the Chopsticks/PAPI experiment for Bifrost reply-leg `SetTopic`
  preservation.
- If Bifrost preserves `SetTopic(requestId)`, promote topic matching as the
  correlation method.
- If not, document and validate the fallback before any production vDOT volume.
- Keep vDOT/yield public positioning gated until this proof exists and the
  week-12 work primitive gate passes.

### Schema-Native Jobs

- Status: first-wave runtime schemas, public docs sync, submit-time validation,
  pre-verifier validation, schema-native submission metadata, the read-only
  `/jobs/validate-submission` route, SDK validation helpers, the exact submit
  contract in job definitions/preflight, and the hosted product-proof worker
  loop validating before claim are implemented. The operator run-detail UI
  surfaces the `submissionContract` and a Validate Draft affordance, and the
  submit handler is guarded by `runGuardedSubmit` in
  `app/lib/api/guarded-submit.js` so a structured-required job will not fire
  `POST /jobs/submit` on a draft that fails validation. Regression covered by
  `app/lib/api/guarded-submit.test.mjs` ("structured-required job validates
  first; invalid response prevents /jobs/submit"). The product-proof worker
  loop now records both the valid direct-object validation and a read-only
  rejected `submission.output` wrapper probe before claim, and the
  product-proof gate asserts the hosted schema index contains the built-in
  first-wave registry. Live product-proof worker-loop evidence has passed, and
  the SDK now exposes `assertSchemaNativeSubmissionReady` for generic helper
  workflows so the valid direct-object trace plus rejected wrapper probe can be
  reused outside the product-proof loop.
- Remaining: extend the schema-native readiness helper to remaining
  third-party/reference-agent helper workflows as they graduate to structured
  output, and add signed registration before tightening custom/off-platform
  schema refs.

### Verifier Replay Hardening

- Status: first-wave schema refs, versioned fixtures, and replay metadata are
  now present for the current verifier set.
- Remaining: split verifier policy version from verifier config version before
  rules move beyond simple config data, and require handler-versioned replay
  fixtures before adding v2 verifier handlers.

### Dispute And Arbitration Flow

- Status: dispute verdict/release mutations now use scoped idempotency
  envelopes, and `POST /disputes/:id/verdict` dispatches
  `EscrowCore.resolveDispute` when the blockchain gateway is enabled.
- Remaining: prove the verdict path on the hosted stack with the configured
  arbitrator/gateway, decide whether `/release` stays a local mutual-release
  receipt or needs an explicit on-chain release action, store arbitrator
  reasoning under `/content/:hash`, surface `disputedAt`, SLA countdown, reason
  code, and on-chain tx state in the operator app, and provision/rehearse the
  phase-0 arbitrator key plus notification path.

### Idempotency And Mutation Hardening

- Optional ingestion-run idempotency now covers provider ingestion routes where
  callers need whole-run replay semantics.
- Dispute verdict and release routes now use scoped idempotency envelopes while
  preserving their canonical dispute receipts for timeline/profile reads.
- Reuse the receipt wrapper for future direct settlement override routes.

### Timeline And Operator UX

- Status: backend and client timeline surfaces support source, topic, phase,
  severity, correlation-id, wallet filters, and persisted event replay. Local
  claim-lock funding, verification settlement/rejection, disputed verification,
  dispute verdict, and stake-release receipts now emit canonical settlement
  timeline events with direct job/session/wallet/correlation fields instead of
  being visible only through state transitions or chain-shaped topics. The
  operator app now exposes URL-backed job/session timeline filters for source,
  topic, phase, severity, wallet, and correlation id.
- Remaining: standardize any remaining producer topics/payloads and keep filter
  presets aligned with the canonical event taxonomy.

### Capability Model

- Status: typed SDK surface, docs, operator grant/revoke runtime flows,
  grant-backed service-token issue/rotate/revoke APIs, public onboarding
  guidance, `authPolicy.uiControls` UI gating, and audit events are present.
  Grant-cache invalidation now makes operator-issued revokes effective on the
  next request in the serving process, with the middleware TTL only as a
  cross-process backstop. The hosted smoke now has an opt-in
  `CHECK_SERVICE_TOKEN_PROOF=1` gate that issues a least-privilege service
  token, proves allowed vs ungranted routes, revokes the grant, confirms the
  old token loses access, and writes sanitized evidence without raw token
  material.
- Remaining: run the hosted service-token proof against production and attach
  its sanitized evidence to the launch pack, then extend delegated-wallet UX
  once native Substrate auth lands.

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

Checked with the Polkadot docs MCP on 2026-05-14:

- ERC20 precompile docs still support the USDC Trust-Backed Asset path on
  Polkadot Hub: Trust-Backed Asset ID `1337`, symbol `USDC`, 6 decimals,
  precompile address `0x0000053900000000000000000000000001200000`.
- XCM precompile docs still describe the fixed precompile address
  `0x00000000000000000000000000000000000a0000`, the low-level `execute`,
  `send`, and `weighMessage` surface, and the requirement that messages are
  SCALE-encoded. The docs explicitly leave higher-level abstractions to be
  built on top, which supports the backend assembler design.
- Data-storage docs still describe Bulletin Chain as retention-limited,
  authorization-gated storage with renewal by `(block, index)` and a mainnet
  authorization model still being finalized. That keeps the spec's
  Bulletin-vs-Crust choice deferred.
- Polkadot docs continue to point to PAPI and Chopsticks for XCM construction,
  replay, and dry-run validation.

That means the current Polkadot-specific plan still holds: USDC for v1 escrow,
and no production vDOT/yield claims until native XCM evidence proves the
correlation and settlement path.

## Recommended Next Queue

1. Complete the hosted worker-loop product-proof evidence gate.
2. Close operator self-report proof against the live production stack by
   retaining `run_hermes_post_deploy=1`, confirming scheduled Hermes ops-health
   and daily-brief evidence, and running the hosted smoke with
   `smoke_check_bootstrap_instrumentation=1`. Treat
   `bootstrap_self_report_send_now=1` plus
   `smoke_check_bootstrap_self_report_sent=1` as an optional branded-email proof
   only after a verified sender domain is configured.
3. Run the hosted schema-native validation proof and extend external helper
   adoption.
4. Prove the dispute verdict path live and decide `/release` semantics.
5. Run the native XCM evidence pack captures.
6. Run the scoped service-token hosted proof with
   `CHECK_SERVICE_TOKEN_PROOF=1` and archive the sanitized evidence.
7. Continue standardizing producer event payloads and finish visible timeline
   filter adoption where still missing.
8. Continue Phase 2+ secrets cleanup and signer custody hardening.
