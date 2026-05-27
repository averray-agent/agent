# Averray Unified Project Roadmap

- **Status date:** 2026-05-27
- **Baseline reviewed:** `origin/main` at `38702bf`
- **Latest docs audit:** [`DOCS_AUDIT_2026-05-19.md`](./DOCS_AUDIT_2026-05-19.md)
- **Purpose:** one status and roadmap page for the specs, audits, launch
  checklists, security plans, and product-proof work.

This page is the current source of truth for "what is done, what is open, and
what comes next." The older docs remain useful for deep context, acceptance
criteria, and implementation notes, but this file owns the unified status.

## Roadmap Authority

Use this file as the operational guideline for sequencing work.

- If another docs file conflicts with this roadmap, this roadmap wins unless
  code, production evidence, or a newer PR proves otherwise.
- Detail docs may define implementation criteria, but they do not reopen or
  close roadmap items by themselves.
- Any PR that materially changes status, launch readiness, mainnet readiness,
  security posture, or deferred scope should update this file in the same PR.
- Historical docs should keep their context, but must point back here instead
  of claiming to be the active roadmap.
- Chain-specific claims should be checked against the Polkadot docs MCP or
  runtime state before they are promoted into this roadmap.
- Parallel agents should not use this file as a shared scratchpad. If a status
  update is not part of a narrow implementing PR, capture it as a fragment in
  [`roadmap-updates/`](./roadmap-updates/) for later steward consolidation.

## Status Terms

- **Done:** merged to `main` and represented in the current deployed or
  deployable product surface.
- **Proofed:** done and backed by a hosted smoke, real workflow, chain proof, or
  durable operator evidence.
- **Ready for proof:** implementation has landed, but hosted, chain, or
  operator evidence is still missing.
- **Blocked:** not actionable until an explicit external dependency, operator
  action, secret, deploy, wallet action, or design decision is complete.
- **In progress:** currently owned by an active PR or assigned worktree.
- **Open:** not implemented, not fully verified, or still blocked by an
  operational prerequisite.
- **Deferred:** intentionally out of v1 or blocked on a later phase gate.

## Parallel Update Protocol

`PROJECT_ROADMAP.md` remains the single source of truth, but parallel agents
should usually submit small update fragments first. This avoids two agents
rewriting the same tables and makes consolidation reviewable.

- Use [`docs/roadmap-updates/README.md`](./roadmap-updates/README.md) for the
  fragment template, file naming, and pasteable agent instruction.
- An implementing PR may directly update the exact roadmap row it closes or
  moves, provided it owns that item and includes evidence.
- A research, audit, design, or handoff PR should usually add a roadmap-update
  fragment instead of editing this file.
- The roadmap steward consolidates accepted fragments into this file and deletes
  or archives consumed fragments in a separate narrow PR.
- Avoid formatting-only changes, table reshuffles, or broad wording edits unless
  the task is explicitly a roadmap-steward consolidation.

## Current Product Posture

Averray is currently a **testnet product-proof platform**. The core backend,
operator app, public discovery/trust surfaces, schema-native job path, USDC
settlement route, service-token capability primitives, and product-proof worker
loop have all landed.

It is **not yet mainnet real-funds ready**. Mainnet readiness still requires an
external audit, mainnet custody/secrets setup, mainnet contract deployment,
control-plane rehearsals, production observability, backups/restore proof, and
final launch gates.

The v1 business and technical posture is:

- USDC-only escrow settlement.
- No platform token.
- Reputation and receipts first.
- Yield, vDOT, and native XCM-backed earning strategies are deferred until after
  the week-12 product gate and native XCM evidence gate.

Polkadot-specific USDC facts were checked against the Polkadot docs MCP:

- USDC is a Polkadot Hub Trust-Backed Asset.
- Asset ID: `1337`.
- Decimals: `6`.
- ERC20 precompile: `0x0000053900000000000000000000000001200000`.
- The ERC20 precompile supports `transfer`, `transferFrom`, `approve`,
  `allowance`, `balanceOf`, and `totalSupply`.
- ERC20 metadata functions `name()`, `symbol()`, and `decimals()` are not
  implemented on the precompile, so the platform must treat metadata as static
  configured asset metadata.

## Source Docs Consolidated Here

| Document | Current role |
| --- | --- |
| [`AVERRAY_WORKING_SPEC.md`](./AVERRAY_WORKING_SPEC.md) | Product architecture and v1/v2/v3 strategy. Keep for detailed business and blockchain model. |
| [`AUDIT_REMEDIATION.md`](./AUDIT_REMEDIATION.md) | Detailed audit finding definitions and acceptance criteria. Some statuses are now stale; use this roadmap for current status. |
| [`CORE_FRAMEWORK_ROADMAP.md`](./CORE_FRAMEWORK_ROADMAP.md) | Framework implementation detail for jobs, sessions, verification, SDK, timelines, and operations. |
| [`SPEC_AUDIT_2026-05-13.md`](./SPEC_AUDIT_2026-05-13.md) | Historical reconciliation audit. Superseded for current status, still useful for rationale. |
| [`DOCS_AUDIT_2026-05-19.md`](./DOCS_AUDIT_2026-05-19.md) | Latest audit of roadmap/spec/checklist doc drift and missing governance. |
| [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) | Operator launch gate. Still authoritative for go/no-go checkboxes. |
| [`PRODUCT_PROOF_GATE.md`](./PRODUCT_PROOF_GATE.md) | Product-proof evidence and smoke command references. |
| [`PHASE_4B_STAGE_2C_PLAN.md`](./PHASE_4B_STAGE_2C_PLAN.md) | Current KMS JWT cutover plan (Stage 2C-1 → 2C-2 → 2C-3). |
| [`PHASE_4E_PLAN.md`](./PHASE_4E_PLAN.md) | Hardware MFA enrollment plan + adjacent mainnet-prep (IAM Roles Anywhere, multi-region KMS, worker-loop refresh-flow). |
| [`SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md) | Secrets and custody migration history and mainnet requirements. |
| [`THREAT_MODEL.md`](./THREAT_MODEL.md) | Launch threat model and security posture. |
| [`RC1_WORKING_SPEC.md`](./RC1_WORKING_SPEC.md) | Historical only. |
| [`RC1_IMPLEMENTATION_PLAN.md`](./RC1_IMPLEMENTATION_PLAN.md) | Historical rc1 slice tracker. Keep for old acceptance criteria only. |

## Completed Foundations

| Area | Status | Evidence |
| --- | --- | --- |
| Trust-core product model | Done | Current working spec v2.10 locks receipts, reputation, no token, USDC-only v1. |
| USDC settlement baseline | Done | Contracts and product-proof path use USDC Trust-Backed Asset ID 1337. |
| Product-proof worker loop | Proofed | Hosted proof in `PRODUCT_PROOF_GATE.md`. Deploy Production workflow run `25988470399` (2026-05-17), dispatched with `smoke_check_product_proof_gate=1` and `product_proof_require_worker_loop=1`. |
| Public proof pages | Done | Homepage proof stream relabeled/scripted; public discovery/schema/trust pages exist. |
| Schema-native first-wave jobs | Done | Schema validation and canonical job output path landed. |
| Job definitions and submit payload ergonomics | Done | `/jobs/definition` and submission schema guidance hardened. |
| Recurring jobs runtime | Done | Recurring templates and reserve accounting implemented. |
| Sub-job orchestration and lineage | Done | Parent/child job lineage and receipt linkage implemented. |
| Typed SDK/client surface | Done | SDK types and generated surfaces in place. |
| Shared validation types | Done | API/schema validation types shared with client scripts where practical. |
| Service-token capability primitives | Done | Scoped issue/sign/rotate/revoke primitives landed; hosted proof path exists. |
| Event/timeline trace model | Done | Persistent timeline/event trace and richer filters added. |
| Claim/session state machine | Done | Claim expiry, effective state, active-session surfaces, and lifecycle signals added. |
| Reference-agent guarded workflow | Done | Claim/submit guards, run ID propagation, evidence helpers, validation, Slack/operator reporting. |
| Mutation backend gate | Done | `P1.1` closed by backend production mutation guard and follow-up docs. |
| Health truth split | Done | `/health` now separates hard health from warnings; frontend topbar warnings surfaced. |
| Account overlay durability | Done | `P1.2` closed by overlay classification, precedence, and write-through storage. |
| Money-route idempotency | Done | Sync money routes gained idempotency/replay contract. |
| Operator frontend truth modes | Done | Main operator pages no longer silently render stale fixture truth as live data. |
| Public site truth labeling | Done | Deterministic "Live" proof stream issue closed by scripted/example labeling. |
| Policy durability | Done | Durable `PolicyService` and extracted built-in seed landed. |
| Generated output guard | Done | CI guard prevents normal PRs from committing generated `frontend/` and `site/` output. |
| Testnet owner multisig | Done | Multisig owner verified in deployment manifest and used for owner-only rehearsal. |
| Testnet KMS verifier signer | Done | Raw verifier key removed from steady-state testnet signing path. |
| Phase 2 VPS env-render cutover | Done | Backend + indexer env files rendered at deploy time via `op inject` from `deploy/*.env.template` into `/run/agent-stack/*.env` (tmpfs, mode 0400). Service-account-scoped 1Password tokens; no plaintext secrets at rest in `/srv`. |
| Boot-time env render service | Done | `deploy/agent-stack-env-render.service` (systemd oneshot, `Before=docker.service`) re-renders `/run/agent-stack/*.env` after every reboot via `scripts/ops/render-vps-env-all.sh`. Validated by destroy-and-recover test and a full prod reboot through kernel `6.8.0-117`. Ships in `#436` + hotfix `#437`. |
| GitHub org code-security configuration | Done | Org-level configuration `248474` enforced on `averray-agent/agent`: secret scanning + push protection + non-provider patterns + generic-secret AI detection + validity checks. New repos in the org auto-enable secret scanning, push protection, and Dependabot via the org default flags. |
| KMS JWT migration through Stage 2C-1 | Done | Five stages live in prod: **Stage 1** (`JWT_BACKEND=both`, `#430`) — verifier accepts HS256 + ES256; **Stage 2A** (`#432`) — SIWE + `/auth/refresh` route through `signTokenFromConfig`; **Stage 2B** (`#433`) — multi-role ES256 (`roles: [...]` array claim); **Stage 2B activation** (`#434`) — `JWT_PRIMARY_ALG=kms` flipped, SIWE actively mints multi-role ES256 against the KMS key; **Stage 2C-1** (`#438`) — `signServiceToken` migrated to dispatcher with `roles: ["service"]`. End-to-end verified in prod (admin+verifier wallet returns 48 capabilities via `/auth/session`). Remaining: Stage 2C-2 env flip (`#439`, draft) and Stage 2C-3 HMAC retirement (≥30d after 2C-2). |

## Open Work To RC1/Testnet Launch

These are the remaining items before calling the hosted testnet platform
externally ready.

### P0 Launch Gates

| Item | Status | Close criteria |
| --- | --- | --- |
| Control-plane pauser | Ready for proof | `TreasuryPolicy` already scopes `pauser` to `setPaused(bool)`. `scripts/ops/run-pauser-rehearsal.mjs` now proves the live pauser can pause, cannot call owner-only functions, and reports role overlap. Read-only proof captured in `docs/evidence/pauser-rehearsal-readonly-2026-05-21.json`. Close after the live testnet evidence is recorded; mainnet must run with `--require-dedicated-pauser`. |
| Pause/unpause rehearsal | Ready for proof | Run `PAUSER_PRIVATE_KEY=... node scripts/ops/run-pauser-rehearsal.mjs --profile testnet --live --out docs/evidence/pauser-rehearsal-testnet-YYYY-MM-DD.json`, then record the pause and unpause tx hashes in `PRODUCTION_CHECKLIST.md`. |
| Hosted product-proof worker loop E2E (claim → submit → verify → settle) | Proofed | Worker-loop E2E proven green on testnet 2026-05-26 after layered unblock (multisig serviceOperators, KMS signer USDC funding, admin EOA rotation, EscrowCore redeploy with `claimJobFor` selector). See PR #525 for the EscrowCore redeploy that completed the loop. Audit gate green against new contracts. |
| Postgres backup readiness | Proofed | Hosted Backup Snapshot Proof run `26531944215` on 2026-05-27 created `/srv/agent-stack/backups/postgres/agent-20260527-205325.sql.gz`, then validated `docs/evidence/backup-readiness-hosted-2026-05-27.json` with `overallStatus: "ok"`, Postgres `status: "ok"`, and `ageSeconds: 3`. Artifact: `hosted-backup-snapshot-proof-26531944215`. |
| Redis backup readiness | Proofed | Same hosted proof run `26531944215` created `/srv/agent-stack/backups/redis/redis-20260527-205325.rdb.gz`, then validated `docs/evidence/backup-readiness-hosted-2026-05-27.json` with Redis `status: "ok"` and `ageSeconds: 2`. Earlier run `26530318040` exposed the stdin-drain bug that skipped Redis; `#550` fixed the scripts/workflow before this proof. |
| Restore drill | Ready for proof | Operator can run the disposable-target restore drill manually, or run the `Hosted Backup Restore Drill Proof` workflow. The hosted workflow reads the latest readiness JSON from the VPS, copies only the selected Postgres/Redis backup files into a GitHub runner, restores them into disposable Docker containers, writes `restore-drill-evidence-v1`, validates it with `check-restore-drill-evidence.mjs`, and uploads a 90-day artifact. Close after the live workflow produces validated evidence with backup file names, Postgres schema-table count, Redis `DBSIZE`, and the readiness JSON captured. |
| Hosted `/admin/status` async XCM smoke | Proofed | `scripts/ops/check-hosted-stack.sh` (the "Checking admin async XCM status" step) asserts (a) `.xcmSettlementWatcher.running == true` — proves the watcher's `start()` loop is alive, not just that the watcher was wired in, (b) when `.xcmObservationRelay.enabled == true`, `.running == true` AND `.lastError` is null/empty — catches a sticky upstream observer-feed error, and (c) an optional freshness gate on `.xcmObservationRelay.lastSyncedAt` (default 1800s, tunable via `XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC`) — catches a stalled poll loop. Structural lock-in tests in `scripts/ops/check-hosted-stack.test.mjs` prevent the assertions from being silently dropped. Wired into deploy in `#473`. Live evidence: Deploy Production run `26256776666` on 2026-05-21 (post-#473 merge at `b451ffed`) reached `Checking admin async XCM status` against live `/admin/status` with the rotated ES256 `ADMIN_JWT` and continued past all three new assertions to `Hosted stack smoke check passed.`. The latest deploy `26273097236` on 2026-05-22 (post-#464 at `bcda8e4`) confirmed the assertion bundle holds steady across an unrelated change. |
| Metrics auth | Ready for proof | Code deployed in `#445`; hosted `/metrics` now fails closed with `503 metrics_auth_unconfigured` when no scraper token is configured. Close after production `METRICS_BEARER_TOKEN` is set and `CHECK_METRICS_AUTH=1` proves unauthenticated `401` plus scraper-token `200` against the hosted stack. Combined evidence for this row, Sentry/logging, and Alert destination lands in one `docs/evidence/observability-YYYY-MM-DD.json` artifact validated by `node scripts/ops/check-observability-proof.mjs --file ... --json` (`#481`). |
| Sentry/logging decision | Ready for proof | Backend/frontend Sentry posture is recorded in `OBSERVABILITY_POSTURE.md`; backend 5xx capture falls back to structured JSON logs and optional Sentry has regression coverage. Close after an operator verifies structured logs are visible from the active deploy target, and `observability.sentry_ready` is observed if Sentry is enabled. Evidence shape validated by `check-observability-proof.mjs` (`#481`) — operator records the decision + log-visibility check in the same observability artifact as Metrics auth and Alert destination. |
| Alert destination | Ready for proof | Alert wrapper is tested for structured webhook delivery on smoke failure in `#449`. Close after `ALERT_WEBHOOK_URL` is configured in the production scheduler environment and one deliberate hosted smoke failure reaches the operator channel. Captured in the observability evidence artifact (`#481`) alongside metrics auth and Sentry decision. |
| Operator self-report evidence | Done | `Hermes Operator Report` workflow schedules and manually runs `ops_health` and `daily_operator_brief` through Hermes with correlation IDs, step summaries, and 90-day artifacts. Production proof: operator report run `26211100734` on 2026-05-21 produced artifacts `hermes-operator-report-ops_health-26211100734-1` and `hermes-operator-report-daily_operator_brief-26211100734-1`, both `success`, with no obvious secret patterns found in downloaded evidence. Post-deploy proof run `26241427864` uploaded artifact `hermes-post-deploy-26241427864`. Hosted bootstrap instrumentation proof run `26241544177` passed `CHECK_BOOTSTRAP_INSTRUMENTATION=1` against live `ADMIN_JWT`; the log reached `Checking bootstrap instrumentation` and ended with `Hosted stack smoke check passed.` Branded email delivery remains optional/deferred. |
| Dispute verdict hosted proof | Ready for proof | `scripts/ops/check-hosted-stack.sh` now has an opt-in `CHECK_DISPUTE_VERDICT_PROOF=1` gate that runs `run-dispute-verdict-proof.mjs` with `DISPUTE_PROOF_LIVE=1`, requires chain dispatch (`confirmed` or `submitted`, never `local_only`), asserts the persisted dispute matches the verdict response, and can write `DISPUTE_PROOF_EVIDENCE_FILE`. Close after the operator runs it against a specific hosted open dispute and records the evidence artifact + tx hash. Polkadot docs MCP check: official Polkadot Hub smart-contract docs confirm REVM/Solidity contract support; no protocol semantics changed in this PR. |
| Public discovery/schema/trust gate | Proofed | `scripts/ops/check-product-proof-gate.mjs` (deep-equal between `https://averray.com/.well-known/agent-tools.json` and `https://api.averray.com/agent-tools.json`, plus onboarding + trust + schema page integrity) runs on every Deploy Production via `DEPLOY_SMOKE_CHECK_PRODUCT_PROOF_GATE='1'` default for auto-deploys — see workflow YAML and structural lock-in tests in `scripts/ops/check-product-proof-gate.test.mjs`. Wired into deploy in `#472`. Live evidence: Deploy Production run `26256248052` on 2026-05-21 (post-#472 merge at `be4fa8c`) reached `Checking product-proof gate` and continued past `Checking public discovery manifest`, `Checking API discovery mirror`, `Checking onboarding agrees with discovery manifest`, `Checking public trust and schema pages`, `Checking public identity schemas`, and `Checking job schema index and sample schema` to `Product-proof gate passed.` followed by `Hosted stack smoke check passed.`. Both subsequent deploys (`26256776666`, `26273097236`) reproduced the green run, confirming the gate is stable across unrelated merges. |
| Canonical public discovery/API mirror | Proofed | Same gate as the row above — the deep-equal between the public mirror (`https://averray.com/.well-known/agent-tools.json`) and the API mirror (`https://api.averray.com/agent-tools.json`) is what proves the canonical mirror. Same evidence closes both rows: Deploy Production run `26256248052` on 2026-05-21 showed `Checking public discovery manifest` → `Checking API discovery mirror` → `Product-proof gate passed.`, which is the deep-equal assertion in `check-product-proof-gate.mjs` succeeding against live state. |

### P1 Product And Platform Hardening

| Item | Status | Close criteria |
| --- | --- | --- |
| HTTP server route split (`P2.3`) | Done | First slice extracted `/admin/status` and `/admin/bootstrap-self-report/send` into `mcp-server/src/protocols/http/admin-status-routes.js` with route-level tests. Second slice extracted `/admin/jobs/*` reads, ingestion routes, recurring fire/pause/resume, and lifecycle updates into `mcp-server/src/protocols/http/admin-jobs-routes.js` with focused replay and validation tests. Third slice extracted `/admin/capability-grants/*` and `/admin/service-tokens/*` into `mcp-server/src/protocols/http/admin-capability-routes.js` with tests covering projection, idempotency replay, tokenless replay receipts, rotation, and idempotent revoke. Fourth slice extracted `/admin/xcm/observe` and `/admin/xcm/finalize` into `mcp-server/src/protocols/http/admin-xcm-routes.js` with tests covering request-id normalization, replay short-circuiting, and receipt storage. Fifth slice extracted read-only `/admin/github/status` into `mcp-server/src/protocols/http/admin-github-routes.js`. Sixth slice extracted `/gas/health`, `/gas/capabilities`, `/gas/quote`, and `/gas/sponsor` into `mcp-server/src/protocols/http/gas-routes.js` with tests covering public health/capability reads plus authenticated quote/sponsor calls. Seventh slice extracted read-only `/admin/sessions` into `mcp-server/src/protocols/http/admin-sessions-routes.js` with tests covering auth, recent-session reads, job-scoped history, limit parsing, and empty `jobId` behavior. Eighth slice extracted `/verifier/handlers`, `/verifier/result`, `/verifier/replay`, and `/verifier/run` into `mcp-server/src/protocols/http/verifier-routes.js` with tests covering public reads, verifier auth/rate limits, and payload/query fallback behavior. Ninth slice extracted `/session/state-machine`, `/session`, `/session/timeline`, and `/sessions` into `mcp-server/src/protocols/http/session-routes.js` with tests covering public cache headers, wallet ownership, missing-session shape, timeline reads, and history query handling. Tenth slice extracted public `/schemas/jobs` and `/schemas/jobs/:name` into `mcp-server/src/protocols/http/schema-routes.js` with tests covering schema index paths, cache headers, successful schema reads, and unknown-schema 404s. Eleventh slice extracted `/policies` and `/policies/:tag` into `mcp-server/src/protocols/http/policy-routes.js` with tests covering authenticated reads, admin proposals, policy event publishing, tag decoding, unknown policies, and empty tag validation. Twelfth slice extracted public `/badges` and `/badges/:sessionId` into `mcp-server/src/protocols/http/badge-routes.js` with tests covering receipt listing, cache headers, badge metadata construction, decoded session IDs, missing sessions, not-ready badges, and empty session validation. Thirteenth slice extracted authenticated `/alerts` and `/audit` into `mcp-server/src/protocols/http/activity-routes.js` with tests covering auth gating, limit parsing, activity feed responses, auth failure propagation, and unrelated path/method behavior. Fourteenth slice extracted `/content`, `/content/:hash`, and `/content/:hash/publish` into `mcp-server/src/protocols/http/content-routes.js` with tests covering content persistence, owner/admin authorization, publish not-found and disclosure behavior, auto-public reads, private access denial, and unrelated path/method behavior. Fifteenth slice extracted public and worker-facing `/jobs` routes into `mcp-server/src/protocols/http/job-routes.js` with tests covering live job listing, tiers, definitions, recommendations/preflight/explain/reward helpers, sub-job ownership, claim idempotency fallback, submission validation aliases, submit ownership, and unrelated path behavior. Sixteenth slice (`#497`) extracted `/agents`, `/agents/:wallet`, and `/reputation` into `mcp-server/src/protocols/http/profile-routes.js` with tests covering public cache headers, wallet validation, request-logger profile context, authenticated reputation reads, and routing separation from the dedicated badge module. Seventeenth slice (`#505`) extracted `/disputes`, `/disputes/:id`, `/disputes/:id/verdict`, and `/disputes/:id/release` into `mcp-server/src/protocols/http/dispute-routes.js` with tests covering auth, listing, idempotent replay, verdict recording, session transition, release recording, and unrelated path handling. Eighteenth slice (`#508`) extracted authenticated SSE `/events` into `mcp-server/src/protocols/http/event-routes.js` with tests covering query-token auth, event rate limits, durable replay gap events, legacy replay fallback, subscription streaming, close cleanup, and auth failure propagation. Nineteenth slice extracted `/`, `/status/providers`, `/onboarding`, `/agent-tools.json`, `/.well-known/agent-tools.json`, and `/strategies` into `mcp-server/src/protocols/http/public-metadata-routes.js` with tests covering public API metadata, sanitized provider status, onboarding capabilities, discovery cache headers, strategy metadata, and unrelated path/method behavior. Twentieth slice extracted `/payments/send` into `mcp-server/src/protocols/http/payment-routes.js` with tests covering unrelated path handling, idempotent chain-gated relay, asset normalization/defaulting, invalid recipient shape, self-transfer rejection, and non-positive amount rejection. Twenty-first slice extracted `/health` and `/metrics` into `mcp-server/src/protocols/http/operational-routes.js` with tests covering service/capability health separation, degraded service liveness, Prometheus text headers, fail-closed metrics auth, bearer rejection/acceptance, and production auth defaults. Broader protocol groups should split only when it reduces review risk without changing behavior. |
| Product-proof worker liquidity truth source | Done | `/account/position?asset=USDC` exposes the authenticated wallet's direct `AgentAccountCore.positions(wallet, asset)` read with source provenance, and the hosted worker loop prefers that direct position over `/account` summary liquidity before create/claim mutations. Regression coverage proves stale `/account.raw.liquid.USDC` cannot pass when the direct chain position is empty. |
| Frontend auth guard (`P3.7`) | Done | `(authed)/layout.tsx` wraps the operator shell in `<AuthedGuard>`, which consumes `useAuth()` and the pure-decision module `app/lib/auth/auth-guard-decisions.js`. Unauthed visitors see a neutral placeholder and redirect to `/sign-in?next=<path>` (open-redirect-safe, `/sign-in` loops blocked); mid-session 401 cascades via the existing `AuthRefreshBridge` clearing the token store. Hydration-race guarded so neither side of the auth boundary flashes the wrong frame. Tests: `node --test app/lib/auth/auth-guard-decisions.test.mjs` (9 cases); `test:app` extended to cover `app/lib/auth/*.test.mjs`. |
| Verifier replay hardening | Done | Verification audit fields now split `verifierPolicyVersion` from `verifierConfigVersion`; replay drift reports policy-version changes; every registered verifier handler must carry current-version replay fixtures before handler changes. |
| Schema registration for external jobs | Proofed | Core support is wired through admin job creation: signed external schema registrations recover an EVM issuer, require an explicit trusted issuer policy, expose schema hash/URL/trust metadata in `/jobs/definition`, and validate registered external output schemas at `/jobs/validate-submission`. `scripts/ops/check-hosted-stack.sh` exposes `CHECK_EXTERNAL_SCHEMA_PROOF=1`, which posts an archived proof-only admin job with an off-platform schema URL, checks the public definition trust metadata, and proves valid/invalid submissions against the registered schema. `Hosted External Schema Proof` runs that gate from the production GitHub environment and uploads the sanitized evidence artifact. Live evidence: workflow run `26523788447` on 2026-05-27 uploaded `hosted-external-schema-proof-26523788447`; evidence file `external-schema-proof-hosted-26523788447.json` has `status: "passed"`, `definition.outputSignatureVerified: true`, valid submission `submitSafe: true`, and invalid submission rejected at `payload.submission.result`. Polkadot docs MCP check: Polkadot Hub Revive exposes the standard ECRecover precompile (`0x01`) for Ethereum-style signature recovery; this proof changes the platform API path only, not chain semantics. |
| Dispute/arbitration semantics | UI wired, proof pending | Dispute reads now expose an `arbitration` contract with SLA state, allowed verdicts, content-addressed reasoning requirements, release readiness/reason, and the decided release path: verdict submission performs chain/local resolution, while `/disputes/:id/release` is an admin post-verdict operator receipt. The hosted dispute proof asserts these semantics, the SDK forwards idempotency/worker-payout/metadata fields instead of dropping them, and the operator dispute drawer now shows SLA status, release readiness/reason, allowed verdicts, reasoning hash/URI requirements, authority labels, and timeout verdict handling. Remaining close work: rehearse arbitrator notifications against a hosted open dispute. Polkadot docs MCP check: Hub explorers expose transaction/status/metadata history for smart-contract activity, and Polkadot's content-addressed storage docs confirm hash/CID-style records are the right shape for immutable reasoning references; this item changes API/SDK/UI semantics only, not chain behavior. |
| Timeline operator UX verification | Done | Backend trace filters landed, and the operator app exposes URL-backed job timeline filters for source, topic, phase, severity, wallet, and correlation ID. Session drawer reuses the same controls client-side for session movement review. Evidence: `app/components/runs/TimelineEventFilters.tsx`, `app/components/runs/JobTimelinePanel.tsx`, `app/app/(authed)/sessions/page.tsx`, `app/components/sessions/SessionDrawerBody.tsx`, `app/lib/api/hooks.ts`, `mcp-server/src/protocols/http/server.js`, and `mcp-server/src/core/platform-service.test.js`. |
| Reference-agent workflow generalization | Done | General workflow pattern documented in `docs/REFERENCE_AGENT_WORKFLOWS.md` for GitHub, dependency/OSV, open-data, OpenAPI, standards, and Wikipedia job families; anchored to existing claim, submit, schema, and timeline surfaces. |
| Hermes Monitor redesign (Direction A) | In progress | Replace the existing terminal-aesthetic Hermes Handoff Monitor with the Direction A redesign (warm beige + sage/amber, auto-sizing lanes, persistent Hermes co-pilot rail, browser-mission drawer, full keyboard nav, degraded-mode UI, three-tier notifications). Implementation spec: [`docs/HERMES_MONITOR_REDESIGN_SPEC.md`](./HERMES_MONITOR_REDESIGN_SPEC.md) (10-milestone PR plan, M1–M10). Close criteria: all 10 milestones merged; WCAG AA audit clean; one operator-shift acceptance test passes; SSE disconnect → reconnect → catch-up works end-to-end; browser missions spawn/run/report through MissionDrawer; three-tier notifications fire on action-needed transitions. **M1 + M2 landed; M3 in flight** — M3 ships the card vocabulary (unified Card + DegradedCard + CardRouter dispatch, plus fixture data so the rich-mix board renders end-to-end across the action / review / checking / queue / deploying / done lanes). |

HTTP route-split closeout audit after `#526`: `mcp-server/src/protocols/http/server.js` now keeps route behavior delegated to focused `*-routes.js` modules. The remaining inline code is shared HTTP plumbing: CORS preflight, low-cardinality metric labeling, route dispatch ordering, request logging, idempotency helpers, and normalized error handling. Any future helper or middleware extraction should be tracked separately and only done when it reduces review risk.

## Auth, Secrets, And Capability Roadmap

### Completed

- Service-token capability model and primitives (scoped issue/sign/rotate/revoke).
- Scoped service-token proof route + `Hosted Service Token Proof` workflow.
- Refresh-cookie auth flow with strict-replay semantics (`#410` + `#417`).
- KMS-backed verifier signer on testnet (Phase 3 KMS cutover).
- Admin EOA rotation 2026-05-25 — drained 9.34 USDC + ~9970 PAS from
  `0xFd2EAE2043243fDdD2721C0b42aF1b8284Fd6519` to
  `0x6778F050eAc8313e4dbB176d7BAB44510E833ac8` after in-session key leak,
  role transitions via multisig `setPauser` + `setArbitrator(new, true)` +
  `setArbitrator(old, false)`. PR #522.
- Audit gate hardened with three new checks (PRs #518, #520, #521):
  `serviceOperators[backend-signer]` presence, signer USDC liquidity vs
  reward+stake, deployed-bytecode selector presence vs gateway-bundled ABI.
  Catches the class of cutover misconfig that caused the 2026-05-25 worker-loop
  debugging session pre-deploy at green/red gate time.
- Phase 4b — KMS JWT migration, complete in prod:
  - **Stage 1** (`#430`): `JWT_BACKEND=both` — verifier accepts HS256 + ES256.
  - **Stage 2A** (`#432`): SIWE + `/auth/refresh` route through `signTokenFromConfig` (dispatcher introduced earlier in `#407` / Phase 4b.4).
  - **Stage 2B** (`#433`): multi-role ES256 — `KmsJwtSigner` emits canonical `roles: [...]` array claim; verifier accepts either shape for backward compat.
  - **Stage 2B activation** (`#434`): `JWT_PRIMARY_ALG=kms` — SIWE actively mints multi-role ES256 against the KMS key; existing HS256 sessions migrate as their TTL expires.
  - **Stage 2C-1** (`#438`): `signServiceToken` routes through dispatcher with `roles: ["service"]`; `VALID_ROLES` widened to accept the synthetic service role.
  - **Stage 2C-2** (`#439`): `JWT_BACKEND=kms` cutover — verifier refuses HS256, accepts only ES256 against the JWT KMS key. Live in prod since 2026-05-21.
  - **Stage 2C-3** (`#463`): retired the four `AWS_*_ACCESS_KEY_*` lines from `deploy/backend.env.template`. Backend's KMSClient now resolves credentials via IAM Roles Anywhere only; static IAM keys are no longer rendered into `/run/agent-stack/backend.env`. 1Password retention runs ~30 days as rollback target.
  - Boot-time JWT KMS credential check (`#444`, hardened in `#457` + `#461`): `validateJwtKmsCredentialAccess` calls `kms:GetPublicKey` against the JWT key with the same Roles Anywhere provider the runtime signer uses. `bootstrap.init_failed` if the credential chain is broken, instead of silently surfacing as a SIWE 500 at first request.
- Phase 5a — IAM Roles Anywhere cutover, live in prod 2026-05-21:
  - Backend's `KMSClient` for both signers (blockchain + JWT) now uses short-lived STS sessions vended by `aws_signing_helper` from X.509 client certs on the VPS (~1h TTL, `ASIA*`-prefixed). Static IAM access keys retired from the env template in `#463`; 1Password items kept for ~30 days as rollback target.
  - Key separation between blockchain signer and JWT signer is enforced by IAM: distinct KMS keys, distinct role names (`averray-signer-testnet-role` vs `averray-jwt-signer-testnet-role`), distinct shared-config profiles. The JWT signer's permissions policy (`deploy/iam-policies/averray-jwt-signer-prod-role.json`) is sign-only with explicit `Deny` on key-deletion / key-disable / policy-mutation.
  - Phase 5a operator setup + runbook in [`docs/PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md`](./PHASE_5A_IAM_ROLES_ANYWHERE_PLAN.md). Remaining: Phase 5a-retire (≥30 days after 2026-05-21) deletes the static IAM keys + their 1Password fields.
- Phase 2 VPS env-render cutover: deploy-time + boot-time render of `/run/agent-stack/*.env` from 1Password (`#436` boot service + `#437` hardening fix).
- Deploy-script rollback hardening (`#467` for backend, `#476` for indexer): rollback path now verifies `git checkout` actually moved HEAD and re-renders the env from the rolled-back template before `compose_up`. Closes the class of "half-rolled-back" failure that prevented the Phase 5a Stage 2C-3 outage from auto-recovering.
- GitHub UI hardening: org code-security configuration `248474` enforced (secret scanning + push protection + non-provider + generic-secret + validity checks); org-default flags flipped so future repos inherit the same protection.

### In Flight

- **Worker-loop refresh-flow** — shipped in PR #529. `ADMIN_JWT`
  30-day-manual-rotation path retained for backward compatibility; retire
  after a 30-day soak period proves the refresh path stable in CI.
- **CloudTrail/CloudWatch KMS signing alarms** — shipped in PR #532. Adds a CloudFormation alarm foundation for blockchain/JWT KMS signing, auth failure anomalies, refresh replay detection, and structured `kms.sign.duration` logs. Close after the stack is deployed with baseline-derived thresholds and an alert-channel proof reaches the operator channel.

### Remaining

- **Hardware MFA for admin chain accounts** — Ready for proof. Validator script `scripts/ops/check-hardware-mfa-evidence.mjs` (`#487`) validates `hardware-mfa-evidence-v1` JSON artifacts covering 1Password admin, AWS root, AWS IAM admins, GitHub org admin, domain registrar, and OVH/VPS provider. Close after a sanitized `docs/evidence/hardware-mfa-YYYY-MM-DD.json` artifact validates and the operator confirms recovery paths without storing raw recovery codes in Git. Full enrollment plan in [`PHASE_4E_PLAN.md`](./PHASE_4E_PLAN.md).
- **HMAC retirement (Stage 2C-3 cleanup)** — ≥30 days after 2026-05-21: delete `op://prod-backend/auth-jwt-secrets`, drop the HMAC code branch from `mcp-server/src/auth/jwt.js`, retire `AUTH_JWT_SECRETS` from the secrets inventory + rotation calendar. Dispatcher already refuses HS256 at the verifier level since 2C-2; this is cleanup of unused config/code.
- **Phase 5a-retire** — ≥30 days after 2026-05-21: `aws iam delete-access-key` for the static keys still in 1Password (`op://prod-backend/aws-signer-testnet`, `op://prod-backend/aws-jwt-signer-testnet`), delete the `access-key-id` + `secret-access-key` 1Password fields. Backend already runs entirely on Roles Anywhere — this removes the static-key rollback escape hatch once Roles Anywhere is proven stable.
- Mainnet multi-region KMS from day one.
- CloudTrail/CloudWatch alarms for KMS signing and anomalous auth failures.

## Blockchain And Mainnet Roadmap

### Testnet State

- Polkadot Hub TestNet is the active proving environment.
- Owner multisig exists and is verified.
- KMS verifier signer is active.
- USDC testnet funding, approval, deposit, claim, submit, and settlement have
  all been proven through the product-proof worker loop.

### Mainnet Required Work

| Item | Status | Close criteria |
| --- | --- | --- |
| External audit | Open | Contracts, backend money routes, verifier, auth, and ops runbooks reviewed before real funds. |
| Fresh mainnet multisig | Open | Mainnet owner multisig created with hardware-backed signers. |
| Mainnet contract deploy | Open | Escrow, treasury/account, policy, verifier, registry, and related contracts deployed from audited artifacts. |
| Ownership transfer | Open | Deploy key transfers ownership to multisig as first post-deploy action. |
| Role assignment | Open | Verifier, arbitrator, pauser, and service operators configured and rehearsed. |
| Mainnet asset config | Open | USDC mainnet asset config verified against Polkadot docs and runtime state. |
| Mainnet env/secrets | Open | `CHAIN_ENV=mainnet`, RPC URLs, contract addresses, KMS keys, JWT keys, and service-token secrets configured without raw-key fallbacks. |
| Mainnet smoke | Open | Complete claim/submit/settle smoke at least three times with low-value jobs. |
| Incident response | Open | Paging, pause flow, rollback, and operator escalation rehearsed. |

## Native XCM, vDOT, And Yield Roadmap

Yield remains deferred. The platform should not market or enable vDOT earning
routes until the native XCM and product gates are complete.

| Gate | Status | Close criteria |
| --- | --- | --- |
| Chopsticks Bifrost SetTopic proof | Open | Local/stateful proof that reserve transfer topic correlation works end to end. |
| Async XCM staging deposit | Open | Deposit flow observed with `pendingCount` returning to zero. |
| Async XCM staging withdraw | Open | Withdraw flow observed with expected balance deltas. |
| Async XCM failure proof | Open | Failure/retry path observed and reported correctly. |
| External observer validation | Open | Independent observer can reconcile emitted topic/correlation evidence. |
| Audited strategy adapter | Open | Real strategy adapter audited before any mainnet capital allocation. |
| Week-12 product gate | Deferred | Only evaluate after first 8 weeks of submitted jobs and 12 weeks of elapsed launch data. |

## Week-12 And Post-Launch Roadmap

### Week-12 Gate

The core launch bet is not yield. It is whether third-party maintainers accept
agent work at a useful rate.

Metrics:

- Count only jobs submitted in launch weeks 1-8.
- Evaluate after week 12.
- Primary metric: upstream merge/acceptance rate.
- Continue/scale if acceptance is at least 60%.
- Diagnose and narrow if 40-59%.
- Cut budget or stop weak lanes if below 40%.

### v1.x After Gate

- Public reputation API.
- Reference contract for receipt verification.
- Three pilot integrations with external operators or agent frameworks.
- More job families beyond Wikipedia/OSS only after schema and verifier
  discipline are repeatable.

### v2

- Reputation distribution.
- Public, composable reputation trails.
- Agent portability beyond Averray-operated jobs.

### v2.5 / v3

- Spending authority for trusted agents.
- More autonomous capital routing only after trust, arbitration, and incident
  handling are proven.

## Current Open PRs And Issues

As of 2026-05-19:

- Open issues in `averray-agent/agent`: none.
- Open PRs:
  - `#439` draft: Stage 2C-2 KMS-only JWT backend flip. Blocked on soak and
    verification criteria above.

## Immediate Work Queue

1. Keep `#439` draft until `#438` has soaked and the service-token/auth checks
   pass under `JWT_BACKEND=both`. Then mark ready → auto-merge picks it up and
   the Stage 2C-2 deploy refuses HS256.
2. Track the Stage 2C-3 HMAC retirement window: ≥30 days after `#439` lands,
   delete `op://prod-backend/auth-jwt-secrets`, drop the HMAC code branch
   from `mcp-server/src/auth/jwt.js`, and retire `AUTH_JWT_SECRETS` from the
   secrets inventory + calendar.
3. Close the remaining `PRODUCTION_CHECKLIST.md` P0 launch gates:
   pauser/rehearsal, backups, restore drill, `/admin/status` hosted check,
   metrics/logging/alerts, self-report evidence, dispute verdict proof, and
   public discovery/schema/trust proof.
4. Open or assign a narrow PR for `P2.3` route split if no existing agent
   owns it. (`P3.7` frontend auth guard closed; row marked Done above.)
5. Operator: act on `PHASE_4E_PLAN.md` § 7 decision points (one vs two
   operators, registrar identity + FIDO2 support, GitHub org-2FA member
   audit before flipping enforcement) before procuring YubiKeys.
6. Keep native XCM/vDOT work behind the staging evidence gate and week-12
   product gate.

## Completion Definition

The project should be tracked in three completion layers:

1. **RC1/testnet launch complete:** hosted testnet platform can be used by
   external agents with truthful public surfaces, proven worker loop, known
   launch controls, and no unresolved P0 checklist items.
2. **Mainnet real-funds complete:** external audit, mainnet custody, mainnet
   deployment, low-value smoke tests, and incident controls are complete.
3. **Business thesis complete:** week-12 acceptance gate passes, pilot
   integrations exist, and the receipt/reputation network is useful without
   relying on token speculation or unproven yield.
