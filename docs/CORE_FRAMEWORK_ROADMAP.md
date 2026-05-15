# Core Framework Roadmap

This roadmap turns the current platform framework into a more durable
production core.

The current product and architecture source document lives in
[AVERRAY_WORKING_SPEC.md](AVERRAY_WORKING_SPEC.md). Use that spec as the
roadmap boundary when prioritizing contract, backend, indexer, and operations
work. [RC1_WORKING_SPEC.md](RC1_WORKING_SPEC.md) is retained as historical
context only. The PR-sized rc1 execution sequence still lives in
[RC1_IMPLEMENTATION_PLAN.md](RC1_IMPLEMENTATION_PLAN.md), and the latest
cross-plan reconciliation lives in
[SPEC_AUDIT_2026-05-13.md](SPEC_AUDIT_2026-05-13.md).

It is intentionally grounded in the code that exists today:

- [mcp-server/src/core/platform-service.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/platform-service.js)
- [mcp-server/src/core/job-catalog-service.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/job-catalog-service.js)
- [mcp-server/src/core/job-execution-service.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/job-execution-service.js)
- [mcp-server/src/core/state-store.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/state-store.js)
- [mcp-server/src/services/verifier-service.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/services/verifier-service.js)
- [mcp-server/src/services/verifier-handlers.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/services/verifier-handlers.js)
- [docs/patterns/recurring-jobs.md](/Users/pascalkuriger/repo/Polkadot/docs/patterns/recurring-jobs.md)
- [docs/patterns/sub-job-escrow.md](/Users/pascalkuriger/repo/Polkadot/docs/patterns/sub-job-escrow.md)

The goal is not to add complexity for its own sake. The goal is to make
jobs, sessions, verification, and operator flows easier to trust, easier to
integrate, and easier to operate under real load.

---

## Current baseline

What the framework already does well:

- jobs are normalized into a consistent catalog shape
- claim flows have idempotency keys and claim locks
- verification is pluggable at the handler level
- verification results persist replay inputs and verifier config snapshots
- recurring templates now have a scheduler runtime, reserve policy, admin
  status, and operator controls
- sub-jobs now have active-worker creation, parent/child indexes, delegation
  policy, reward reservation, and profile/operator lineage surfaces
- the HTTP layer exposes enough surface area to support an operator console
- the SDK/client surface covers the first external integration path
- job/session event traces persist through memory and Redis state stores

What is still thin:

- verifier contracts still need stronger schema and handler-version replay
  discipline
- first-wave job schemas need stricter runtime enforcement
- settlement, timeout, and dispute phases need fuller state-machine coverage
- funding, settlement, and dispute events are not fully folded into one trace
- visible operator filters lag the backend timeline filter surface
- native XCM/vDOT remains gated on real evidence capture, not implementation
  scaffolding alone
- launch operations still have open proof items: hosted worker loop, backup
  restore drill, pauser rehearsal, self-report delivery, and secrets cutover
  stability

---

## Principles

Every framework upgrade below should follow these rules:

1. Prefer explicit state and contracts over inferred behavior.
2. Keep the on-chain scope as small as possible unless stronger guarantees are worth the audit cost.
3. Make operator behavior observable in timelines, not just logs.
4. Bias toward schema-first jobs and replayable verification.
5. Upgrade runtime pieces in layers so launch readiness keeps moving.

---

## Workstreams

### 1. Verifier contracts and replayability

### Why this matters

Today, verifier behavior is concentrated in
[mcp-server/src/services/verifier-handlers.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/services/verifier-handlers.js)
and works for v1, but the contract between:

- posted job
- worker submission
- verifier handler
- persisted verification result

is still too loose for high-trust operation.

### Current implementation

- job definitions and preflight responses expose a `verificationContract`
  envelope with handler, verifier config version, config hash, and replay/result
  endpoints
- verification results persist `verificationInput`,
  `verificationInputHash`, `verifierConfigSnapshot`, `verifierConfigHash`,
  `verifierConfigVersion`, and `handlerVersion`
- direct verification ingestion and `/verifier/run` both enrich stored verdicts
  with the same audit fields
- `/verifier/replay` evaluates against the stored verifier config snapshot when
  one exists, so audits are not silently affected by later config edits

### Remaining gaps

- `benchmark` and `deterministic` handlers can still operate on plain text
  evidence for legacy jobs
- verifier policy version is not yet separate from verifier config version
- replay still uses the current handler implementation; `handlerVersion`
  records the version that ran, but the code itself is not version-pinned

### Concrete next changes

- add `evidenceSchemaRef` or `submissionSchemaRef` to jobs
- split `policyVersion` from `verifierConfig.version` when verifier rules move
  beyond simple config data
- add handler-versioned replay fixtures before introducing v2 verifier handlers

### What this unlocks

- safer verifier iteration
- better dispute handling
- easier auditability
- lower risk when adding richer handler types later

---

### 2. Schema-native jobs

### Why this matters

The platform already points at schema-first jobs through
`inputSchemaRef` and `outputSchemaRef`, and the first built-in schema-native
paths now validate against the runtime registry before submit and verifier
execution. Real quality control still depends on verifier terms and operator
discipline for custom/off-platform schemas.

### Current state

- `docs/schemas/jobs/` is generated from the runtime registry and checked in CI
- first-party schemas exist for PR review findings, release readiness, issue
  triage, and docs drift audit
- built-in schema-native outputs are validated at submit time and again before
  verifier execution
- `/jobs/definition.submissionContract` and `/jobs/validate-submission` remain
  the no-mutation source of truth for exact submit shape
- the SDK exposes fail-closed helpers that validate drafts before claim/submit
  mutations (`claimJobAfterValidation` and `submitValidatedWork`)
- the hosted product-proof worker loop now uses a built-in
  `schema://jobs/product-proof-worker-loop` output contract, validates its
  structured submission before claim, probes an invalid `submission.output`
  wrapper through the read-only validation route, and records both validation
  traces in the launch evidence gate

### Gaps today

- the hosted evidence gate still needs to be run live after deploy with
  `PRODUCT_PROOF_REQUIRE_WORKER_LOOP=1`
- custom/off-platform schema refs are still allowed without signed schema
  registration
- third-party and non-product-proof helper workflows still need to adopt the
  SDK pre-validation helpers / `/jobs/validate-submission` before-claim pattern
- richer verifier replay fixtures should land before introducing v2 handlers

### Improve to

- job creation that verifies referenced schemas exist
- richer operator errors for invalid structured submissions
- signed schema registration for custom/off-platform work

### Concrete next changes

- extend the product-proof validation-before-claim pattern + SDK
  pre-validation helpers to each remaining hosted/reference-agent
  helper workflow as it graduates to schema-native output
- continue tightening custom/off-platform schema refs once a signed schema
  registration flow exists

### What this unlocks

- much higher submission consistency
- lower verifier ambiguity
- better downstream reuse of completed jobs
- a cleaner future SDK contract

---

### 3. Session lifecycle as a real state machine

### Why this matters

Right now session transitions live across
[mcp-server/src/core/job-execution-service.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/core/job-execution-service.js)
and
[mcp-server/src/services/verification-ingestion-service.js](/Users/pascalkuriger/repo/Polkadot/mcp-server/src/services/verification-ingestion-service.js).
That works, but it still behaves more like a set of updates than a strict state
machine.

### Current implementation

- `session-state-machine.js` defines the canonical transition table and public
  status metadata
- claim, submit, verification ingestion, expiry, and dispute resolution now
  route through shared transition guards
- duplicate submit attempts and verifier callbacks on non-verifiable sessions
  fail closed before submission replacement, handler execution, chain
  settlement, or verification result ingestion
- sessions persist compact `statusHistory` entries with reason, timestamp, and
  metadata

### Remaining gaps

- settlement and dispute posture are still mostly transition outcomes and
  metadata, not separately typed workflow phases
- retries and re-open semantics still live primarily in claim handling
- transition coverage is focused on high-risk guards rather than full property
  coverage across every legal and illegal edge

### Concrete next changes

- route future settlement, timeout, and dispute actions through dedicated
  state-machine helpers
- add fixture or property tests for every legal and illegal transition
- expose richer transition reason taxonomy for operator UI timelines and agent
  diagnostics

### What this unlocks

- easier reasoning about edge cases
- better smoke tests and property tests
- clearer UI timelines
- safer dispute and retry features

---

### 4. Idempotency and mutation hardening

### Why this matters

The claim path already has a good start with idempotency keys and claim locks.
Admin mutations and some operator flows should reach the same standard before
load and automation grow.

### Current implementation

- claim idempotency is enforced through session lookup and claim locks
- `POST /admin/jobs`, `POST /admin/jobs/fire`, recurring pause/resume,
  provider ingestion routes, and async XCM actions persist mutation receipts in
  the state store
- admin job creation, manual recurring fires, recurring pause/resume, and
  provider ingestion runs plus async XCM allocate/deallocate plus
  observe/finalize store canonical request hashes with their idempotency
  receipts, so same-key replays return the original result while same-key
  payload drift fails with a clear conflict
- dispute verdict and release routes keep their canonical dispute receipts while
  also storing scoped idempotency envelopes keyed by wallet, dispute id, and
  client key

### Remaining gaps

- future direct settlement override routes should adopt the same receipt wrapper

### Concrete next changes

- reuse the same receipt wrapper for future settlement routes
- expose idempotency replay/conflict metadata in operator-facing docs and SDK
  helpers

### What this unlocks

- safer automation
- cleaner scheduler design
- fewer double-create incidents
- more reliable ops scripts

---

### 5. Job-centric observability

### Why this matters

The platform needs to answer operator questions like:

- what happened to this session?
- why was it rejected?
- which verifier version made that decision?
- did stake move?
- did a recurring template fire?

Some of this exists in logs, some in sessions, some in verification results,
and some only in the operator app. The backend now exposes the shared
job/session timeline spine, but the remaining work is to make every producer
emit into it with the same topic taxonomy.

### Current implementation

- `/session/timeline` exposes v2 session lifecycle, verification, child-job,
  and child-session events
- `/admin/jobs/timeline` exposes v2 job state, sessions, verification,
  child/derivative lineage, and replayed event-bus entries
- timeline entries use one canonical envelope with `id`, `type`, `at`,
  `timestamp`, `correlationId`, `phase`, `source`, `topic`, `severity`,
  direct `jobId` / `sessionId` / `wallet` fields, and compact `data`
- event-bus entries are persisted through the state store in both memory and
  Redis modes, so `/events` replay and `/admin/jobs/timeline` can recover
  recent event traces after a process restart
- `/events` and `/admin/jobs/timeline` accept source, topic, phase, severity,
  and correlation-id filters; the frontend client hook can pass the same filter
  shape through to the backend
- recurring template fire history is reconstructed through derivative jobs,
  and sub-job lineage is reconstructed through `parentSessionId`

### Remaining gaps

- not every producer emits a canonical topic and payload shape yet
- funding and settlement state are not fully folded into the same timeline
- operator UI still needs visible timeline filter controls for source, topic,
  wallet, and correlation id

### Improve to

- event timeline per session
- event timeline per job template
- correlation ids across claim, submit, verify, settle
- admin status that surfaces current operational anomalies

### Concrete next changes

- standardize the remaining platform event topics and payload shapes
- merge funding, settlement, and dispute state into the same job/session trace
- expose visible operator controls for source, topic, wallet, and correlation-id
  filters

### What this unlocks

- faster incident response
- cleaner operator UX
- simpler audit walkthroughs
- better production confidence

---

### 6. Centralized policy and auth capability model

### Why this matters

Auth is currently solid enough for launch, but capabilities are still spread
across environment config, JWT roles, and route-level decisions.

### Current implementation

- `auth-policy-v1` defines the shared base capability set, role expansions,
  method-aware route requirements, UI-control requirements, and automation
  action requirements
- auth middleware resolves capabilities from roles plus optional signed scopes,
  and rejects route access when the required capabilities are missing
- `/auth/session` and `/admin/status` expose the active capability matrix so
  the operator app and automation clients can render controls from backend
  policy instead of duplicating route rules

### Remaining gaps

- signed tokens are still issued from coarse environment role lists
- future fine-grained delegated scopes are supported by the resolver, but do
  not yet have an operator grant/revoke workflow
- some public discovery docs still describe auth action requirements separately
  from the runtime capability matrix

### Improve to

- one capability matrix that maps:
  - roles
  - routes
  - UI controls
  - automation actions
- support for finer-grained admin scopes later without rewriting everything

### Concrete next changes

- add an operator-facing grant/revoke flow for scoped service tokens or
  delegated wallets
- align public onboarding action requirements with the versioned auth policy
  payload
- extend frontend controls to hide/disable actions from `authPolicy.uiControls`
- add audit events when capability grants change

### What this unlocks

- clearer governance
- safer delegated operations
- less drift between frontend and backend access rules

---

### 7. Recurring jobs as a first-class runtime

### Why this matters

Recurring jobs are one of the strongest retention mechanics in the whole
product. The scheduler/runtime foundation is now in place; the remaining work
is proving the live reserve and firing behavior under hosted operation.

### Remaining gaps

- hosted recurring behavior still needs more live proof across real funded
  templates
- missed-fire behavior is conservative and does not backfill every skipped
  interval
- recurring telemetry should stay folded into job/session timelines as the
  event taxonomy matures

### Improve to

- scheduler runtime as a product primitive
- status visibility for templates and reserve exhaustion
- pause/resume controls
- conservative missed-fire behavior

### Concrete next changes

- [x] add a scheduler worker that scans recurring templates on boot
- [x] persist template runtime metadata:
  - `lastFiredAt`
  - `nextFireAt`
  - `lastResult`
  - `paused`
- [x] gate firing on finite template reserve policy
- [x] expose status in admin endpoints
- [x] wire operator UI controls for reserve exhaustion and next firing
- [x] back recurring reserve with escrow-native/on-chain poster funding

### What this unlocks

- recurring jobs as a real product feature
- better retention claims
- less ops glue code

---

### 8. Sub-job orchestration and lineage

### Why this matters

Sub-jobs already work as a pattern, which is good. The next jump is to make
delegation feel like a framework feature instead of just a metadata convention.

### Remaining gaps

- no on-chain parent/child linkage
- no automatic parent-to-child payout streaming
- profile and dashboard lineage surfaces should keep improving as real
  multi-agent workflows create sharper UX requirements

### Improve to

- parent/child execution as a first-class orchestration pattern
- lineage-aware accounting and visibility
- safer worker-initiated sub-job creation

### Concrete next changes

- [x] add a dedicated sub-job creation route that only works for the active worker
  on an in-flight parent session
- [x] persist parent/child indexes for fast lookup
- [x] expose child runs on session detail endpoints
- [x] add delegation budget and depth policy fields
- [x] reserve the child reward from the parent wallet at sub-job creation
- [x] extend profile and operator UI surfaces around sub-contracting history
  (PR #192 added the operator-side `JobLineagePanel` on `/runs/detail`;
  PR #203 added the public agent profile's `lineage` block + delegation
  history section)

### What this unlocks

- cleaner multi-agent workflows
- stronger worker-to-worker marketplace behavior
- better profile and dashboard lineage views

---

### 9. Typed SDK and client surface

### Why this matters

The platform is already programmable, but integrations still rely on raw HTTP
shapes unless they use the first SDK surface. The current client is now good
enough as a first integration path; future work should harden examples and
replay helpers as external agents exercise it.

### Remaining gaps

- canonical integration examples are young and should grow with real external
  agent use
- verifier replay helpers and richer schema examples should be added when
  external verifier operators need them

### Improve to

- one small JS/TS SDK as the first integration path
- generated types or hand-maintained types from the current API surface
- stable helpers for auth, job posting, session operations, and admin actions

### Concrete next changes

- [x] keep hardening `sdk/agent-platform-client.js`
- [x] ensure it wraps:
  - auth nonce + verify
  - list/recommend/preflight jobs
  - claim / submit / resume
  - session and job timeline inspection
  - admin job create / recurring fire / status
- [x] add hand-maintained endpoint response declarations for the current API
- [x] expose structured API errors for automation
- [x] generate SDK types from the API/schema source instead of maintaining them
  by hand
- [x] share validation types with frontend scripts where possible

### What this unlocks

- faster integrations
- less duplicated request glue
- easier automation and external builder adoption

---

## Current Audit Queue

As of [SPEC_AUDIT_2026-05-13.md](SPEC_AUDIT_2026-05-13.md), the next work
should prioritize live-proof and launch-risk items before adding new product
surface:

1. complete the hosted worker-loop product-proof evidence gate, including the
   valid direct-object validation and invalid-wrapper validation proof
2. close operator self-report proof through Hermes/operator reporting: keep
   `run_hermes_post_deploy=1`, confirm scheduled ops-health and daily-brief
   evidence, and run the hosted smoke's bootstrap instrumentation gate to prove
   upstream-status plus optional email status are well-formed and do not leak
   provider/API-key-shaped tokens. Branded Resend email delivery remains an
   optional transport to prove later with `bootstrap_self_report_send_now=1`
   after a verified sender domain exists.
3. tighten schema-native jobs for the first-wave job families and extend helper
   adoption beyond the product-proof loop
4. finish dispute/arbitration launch wiring
5. capture the native XCM deposit, withdraw, and failure evidence pack
6. add visible timeline filters to the operator app
7. continue Phase 2+ secrets cleanup and signer custody hardening

---

## Sequencing

### Phase 1: next 2 weeks

Focus on the changes that improve correctness without expanding the product
surface too much.

- verifier contract versioning
- schema-native first-wave jobs
- explicit session state machine
- broader idempotency on admin writes

Outcome:
- safer v1 launch profile
- cleaner operator debugging
- stronger first job quality

### Phase 2: before launch

These are the upgrades that make the framework more reliable in live
operations.

- job-centric observability
- centralized capability model
- recurring scheduler runtime
- stronger sub-job indexes and views

Outcome:
- better production operations
- clearer admin posture
- recurring jobs become credible as a live product feature

### Phase 3: post-launch

These upgrades matter, but they are less likely to block the first live
release.

- richer verifier modes beyond v1 keyword / deterministic matching
- dedicated sub-job posting route for worker self-delegation
- typed SDK and integration surface
- more advanced scheduler policy and backfill rules

Outcome:
- stronger external adoption
- more expressive workflows
- lower long-term integration cost

---

## Recommended order

If only one sequence is followed, use this one:

1. schema-native jobs
2. verifier contract versioning
3. session state machine
4. idempotent admin mutations
5. job/session timelines
6. recurring scheduler runtime
7. sub-job orchestration
8. capability model
9. typed SDK

Why this order:

- it improves correctness before adding product breadth
- it keeps launch readiness moving
- it upgrades the strongest existing use cases first

---

## Definition of "framework ready enough"

The framework is in a good enough state for broader live use when all of these
are true:

- first-wave jobs validate against concrete schemas
- verification results can be replayed or audited from stored inputs
- session transitions are explicit and tested
- recurring templates can fire without ops glue scripts
- parent/child job lineage is visible in operator surfaces
- operators can inspect a session timeline end to end
- integrations no longer need to reverse-engineer raw request shapes

Until then, the product can still launch, but the framework should be treated
as a careful v1 core rather than a finished platform substrate.
