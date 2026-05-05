# Core Framework Roadmap

This roadmap turns the current platform framework into a more durable
production core.

The rc1 product and architecture source document lives in
[RC1_WORKING_SPEC.md](RC1_WORKING_SPEC.md). Use that spec as the roadmap
boundary when prioritizing contract, backend, indexer, and operations work.
The PR-sized execution sequence lives in
[RC1_IMPLEMENTATION_PLAN.md](RC1_IMPLEMENTATION_PLAN.md).

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
- recurring templates already exist as metadata plus manual fire support
- sub-jobs already work as a platform pattern using `parentSessionId`
- the HTTP layer exposes enough surface area to support an operator console

What is still thin:

- verifier contracts are simple keyword or string matching
- job schemas are references, not strongly enforced contracts
- session lifecycle is implicit, not modeled as a strict state machine
- recurring jobs do not have a first-class scheduler runtime yet
- sub-jobs are linked by convention, not by stronger orchestration rules
- integrations still rely on ad hoc request shapes instead of a typed SDK

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
`inputSchemaRef` and `outputSchemaRef`, but those fields are still
mostly metadata. Real quality control still depends heavily on
verifier terms and operator discipline.

### Gaps today

- schema refs are not strongly validated at job creation time
- submit flows do not validate structured output against a concrete schema
- the first-wave jobs are structured by convention, not enforced runtime
- schema libraries are still sparse outside the public profile and badge docs

### Improve to

- a small reusable schema registry
- job creation that verifies referenced schemas exist
- submit-time validation before verifier execution
- richer operator errors for invalid structured submissions

### Concrete next changes

- keep job schema docs under `docs/schemas/jobs/` aligned with the runtime
  registry
- define first-party schemas for:
  - PR review findings
  - release readiness
  - issue triage
  - docs drift audit
- keep `/jobs/definition.submissionContract` and
  `/jobs/validate-submission` as the no-mutation source of truth for exact
  submit shape
- validate structured output before claim/submit helper flows consume a claim
  attempt
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
- `POST /admin/jobs`, `POST /admin/jobs/fire`, recurring pause/resume, and
  async XCM admin actions can persist mutation receipts in the state store
- admin job creation, manual recurring fires, and recurring pause/resume store
  canonical request hashes with their idempotency receipts, so same-key replays
  return the original result while same-key payload drift fails with a clear
  conflict

### Remaining gaps

- provider ingestion endpoints still rely mostly on deterministic job ids and
  duplicate-skip behavior rather than explicit idempotency receipts
- async XCM actions replay receipts but still need the same canonical
  payload-drift guard as create/fire/pause/resume
- future dispute and settlement routes should adopt the same receipt wrapper

### Concrete next changes

- extend canonical request-hash receipts to async XCM admin routes
- add optional idempotency keys to provider ingestion routes where callers need
  whole-run replay semantics
- reuse the same receipt wrapper for future dispute and settlement routes
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
- recurring template fire history is reconstructed through derivative jobs,
  and sub-job lineage is reconstructed through `parentSessionId`

### Remaining gaps

- not every producer emits a canonical topic and payload shape yet
- event-bus replay is still in-memory, so long-term history is reconstructed
  mostly from state snapshots
- funding and settlement state are not fully folded into the same timeline
- operator UI still needs richer timeline filtering and source labels

### Improve to

- event timeline per session
- event timeline per job template
- correlation ids across claim, submit, verify, settle
- admin status that surfaces current operational anomalies

### Concrete next changes

- standardize the remaining platform event topics and payload shapes
- persist the event log or extend state snapshots where replay windows are too
  short for audits
- merge funding, settlement, and dispute state into the same job/session trace
- expose UI/SDK filters for source, topic, wallet, and correlation id

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
product, but today they are still a pattern plus manual fire endpoint.

### Gaps today

- on-chain poster reserve funding is still represented as backend policy
  metadata rather than an escrow-native subscription pool
- missed-fire behavior is conservative and does not backfill every skipped
  interval
- operator UI still needs richer controls for reserve exhaustion and next
  firing

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

### Gaps today

- profile and dashboard surfaces still need richer sub-contracting views
- no on-chain parent/child linkage
- no automatic parent-to-child payout streaming

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
- [ ] extend profile and operator UI surfaces around sub-contracting history

### What this unlocks

- cleaner multi-agent workflows
- stronger worker-to-worker marketplace behavior
- better profile and dashboard lineage views

---

### 9. Typed SDK and client surface

### Why this matters

The platform is already programmable, but integrations still rely on raw HTTP
shapes. The frontend client in
[frontend/http-client.js](/Users/pascalkuriger/repo/Polkadot/frontend/http-client.js)
proves the need, but it is UI-focused rather than an external integration SDK.

### Gaps today

- typed JS client exists, but generated types from the API source are still a
  later step
- some request shapes are still duplicated across scripts, demos, and frontend
  code
- canonical integration examples are young and should grow with real external
  agent use

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
