# Core Framework Roadmap

This roadmap turns the current platform framework into a more durable
production core.

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

### Gaps today

- `benchmark` and `deterministic` handlers operate on plain text evidence
- there is no versioned verifier config envelope
- verification results are stored, but the framework does not treat them as
  a replayable artifact with a clear input snapshot
- there is no notion of verifier policy version or handler version in the
  stored result

### Improve to

- versioned verifier configs
- explicit evidence shape per verifier mode
- persisted verification input snapshot
- persisted handler version and policy version
- deterministic replay command for disputes and audits

### Concrete next changes

- add `verifierConfig.version`
- add `evidenceSchemaRef` or `submissionSchemaRef` to jobs
- persist `verificationInput`, `verifierConfigVersion`, and `handlerVersion`
  alongside the verdict
- add a `replayVerification(sessionId)` internal path for audit and dispute use

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

- add job schema docs under `docs/schemas/jobs/`
- define first-party schemas for:
  - PR review findings
  - release readiness
  - issue triage
  - docs drift audit
- validate `inputSchemaRef` and `outputSchemaRef` against known schema files
- let `submitWork` accept structured JSON payloads in addition to plain text
- run schema validation before `VerifierService.verifySubmission`

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

### Gaps today

- legal transitions are implicit
- `claimed`, `submitted`, `resolved`, `rejected`, `closed`, `expired`,
  `timed_out` exist, but transition rules are not centralized
- evidence submission, verification, settlement, and dispute posture are not
  modeled as first-class states
- retries and re-open semantics are thin

### Improve to

- one explicit session transition table
- precondition checks per transition
- consistent event emission per transition
- terminal-state semantics enforced in one place

### Concrete next changes

- create a `session-state-machine.js` module
- define allowed transitions and side effects
- route `claimJob`, `submitWork`, verification ingestion, timeout handling,
  and future dispute actions through it
- persist a compact state transition history for each session

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

### Gaps today

- claim idempotency is stronger than job creation idempotency
- posting bundles, recurring fires, and future schedulers need duplicate-safe
  semantics
- some mutation routes still depend on callers simply not repeating requests

### Improve to

- idempotency support across all meaningful write routes
- duplicate-safe admin posting
- clearer conflict codes for retries and replays

### Concrete next changes

- add optional idempotency keys to:
  - `POST /admin/jobs`
  - `POST /admin/jobs/fire`
  - future dispute and settlement routes
- persist mutation receipts in the state store
- expose conflict reasons cleanly for operators and scripts

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

Today, some of this exists in logs, some in sessions, some in verification
results, and some only in the operator app.

### Gaps today

- no unified job/session timeline view in the backend model
- recurring and sub-job lineage are visible only indirectly
- verification and funding state are not yet merged into one operational trace

### Improve to

- event timeline per session
- event timeline per job template
- correlation ids across claim, submit, verify, settle
- admin status that surfaces current operational anomalies

### Concrete next changes

- standardize platform event topics and payload shapes
- store or reconstruct timelines from events plus state snapshots
- add admin/session endpoints for timeline inspection
- include recurring template fire history and parent/child links in those views

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

### Gaps today

- roles are only `admin` and `verifier`
- route protection is clear, but capability composition is still coarse
- environment policy and runtime capability policy are not expressed in one
  source of truth

### Improve to

- one capability matrix that maps:
  - roles
  - routes
  - UI controls
  - automation actions
- support for finer-grained admin scopes later without rewriting everything

### Concrete next changes

- document and codify route-to-capability mapping
- add a capability resolver layer on top of roles
- let admin status expose the active capability model to the operator app
- prepare for future scopes such as:
  - `jobs:create`
  - `jobs:fire-recurring`
  - `verifier:run`
  - `ops:view`

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

- no built-in scheduler worker
- no durable `lastFiredAt` / `nextFireAt` runtime record
- no failure policy beyond external retries
- no reserve-aware fire control

### Improve to

- a proper scheduler runtime
- status visibility for templates
- pause/resume controls
- conservative missed-fire behavior

### Concrete next changes

- add a scheduler worker that scans recurring templates on boot
- persist template runtime metadata:
  - `lastFiredAt`
  - `nextFireAt`
  - `lastResult`
  - `paused`
- gate firing on available reserve and policy checks
- expose status in admin endpoints and operator UI

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

- `parentSessionId` is preserved but not strongly orchestrated
- no parent budget policy or depth policy
- no parent-centric child session view in the backend model
- no narrower route for authenticated worker-created sub-jobs

### Improve to

- parent/child execution as a first-class orchestration pattern
- lineage-aware accounting and visibility
- safer worker-initiated sub-job creation

### Concrete next changes

- add a dedicated sub-job creation route that only works for the active worker
  on an in-flight parent session
- persist parent/child indexes for fast lookup
- expose child runs on session detail endpoints
- optionally add delegation budget fields later

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

- no shared typed client for jobs, sessions, auth, verifier, and admin flows
- request shapes are duplicated across scripts, demos, and frontend code
- no canonical integration surface for third-party builders

### Improve to

- one small JS/TS SDK first
- generated types or hand-maintained types from the current API surface
- stable helpers for auth, job posting, session operations, and admin actions

### Concrete next changes

- create a lightweight `sdk/` package or `mcp-server/src/client/` module
- wrap:
  - auth nonce + verify
  - list/recommend/preflight jobs
  - claim / submit / resume
  - admin job create / recurring fire / status
- share validation types with docs and scripts where possible

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
