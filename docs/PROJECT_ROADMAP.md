# Averray Unified Project Roadmap

- **Status date:** 2026-05-28
- **Baseline reviewed:** `origin/main` at `39ab1b8`
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
| Control-plane pauser | Proofed | Testnet evidence in `docs/evidence/pauser-rehearsal-testnet-2026-05-27.json` proves the live pauser can call `setPaused(bool)`, cannot call owner-only functions, and is distinct from the owner. The proof intentionally preserves the warning that the testnet pauser overlaps deployer/arbitrator; this is acceptable only for bounded testnet launch evidence. Mainnet or real-funds rehearsal must rerun with `--require-dedicated-pauser`. Polkadot docs MCP check: Polkadot Hub TestNet explorers support smart-contract transaction tracking/status and contract interaction history, matching the recorded tx-hash evidence. |
| Pause/unpause rehearsal | Proofed | Live testnet rehearsal captured pause tx `0x67da41f74f014af24c11926a901acca3f98be0fda29fd9ba2034465f8899a3e5` at block `9357194` and unpause tx `0x98ac3689daebef0e116229064b72cc328dc20125fa48f1259a82d2dea1f122ce` at block `9357197`; both receipts have status `1`, and the final on-chain paused state returned to `false`. |
| Hosted product-proof worker loop E2E (claim → submit → verify → settle) | Proofed | Worker-loop E2E proven green on testnet 2026-05-26 after layered unblock (multisig serviceOperators, KMS signer USDC funding, admin EOA rotation, EscrowCore redeploy with `claimJobFor` selector). See PR #525 for the EscrowCore redeploy that completed the loop. Audit gate green against new contracts. |
| Postgres backup readiness | Proofed | Hosted Backup Snapshot Proof run `26531944215` on 2026-05-27 created `/srv/agent-stack/backups/postgres/agent-20260527-205325.sql.gz`, then validated `docs/evidence/backup-readiness-hosted-2026-05-27.json` with `overallStatus: "ok"`, Postgres `status: "ok"`, and `ageSeconds: 3`. Artifact: `hosted-backup-snapshot-proof-26531944215`. |
| Redis backup readiness | Proofed | Same hosted proof run `26531944215` created `/srv/agent-stack/backups/redis/redis-20260527-205325.rdb.gz`, then validated `docs/evidence/backup-readiness-hosted-2026-05-27.json` with Redis `status: "ok"` and `ageSeconds: 2`. Earlier run `26530318040` exposed the stdin-drain bug that skipped Redis; `#550` fixed the scripts/workflow before this proof. |
| Restore drill | Proofed | Hosted Backup Restore Drill Proof run `26537480496` on 2026-05-27 copied the selected backups from the VPS, restored them into disposable GitHub runner containers, and uploaded artifact `hosted-backup-restore-drill-proof-26537480496`. Saved evidence `docs/evidence/restore-drill-hosted-2026-05-27.json` validates with `restore-drill-evidence-v1`: Postgres backup `agent-20260527-205325.sql.gz`, Postgres schema-table count `0`, Redis backup `redis-20260527-205325.rdb.gz`, Redis `DBSIZE` `2788`, and cleanup true for both containers plus the Redis temp dir. |
| Hosted `/admin/status` async XCM smoke | Proofed | `scripts/ops/check-hosted-stack.sh` (the "Checking admin async XCM status" step) asserts (a) `.xcmSettlementWatcher.running == true` — proves the watcher's `start()` loop is alive, not just that the watcher was wired in, (b) when `.xcmObservationRelay.enabled == true`, `.running == true` AND `.lastError` is null/empty — catches a sticky upstream observer-feed error, and (c) an optional freshness gate on `.xcmObservationRelay.lastSyncedAt` (default 1800s, tunable via `XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC`) — catches a stalled poll loop. Structural lock-in tests in `scripts/ops/check-hosted-stack.test.mjs` prevent the assertions from being silently dropped. Wired into deploy in `#473`. Live evidence: Deploy Production run `26256776666` on 2026-05-21 (post-#473 merge at `b451ffed`) reached `Checking admin async XCM status` against live `/admin/status` with the rotated ES256 `ADMIN_JWT` and continued past all three new assertions to `Hosted stack smoke check passed.`. The latest deploy `26273097236` on 2026-05-22 (post-#464 at `bcda8e4`) confirmed the assertion bundle holds steady across an unrelated change. |
| Metrics auth | Proofed | Production `METRICS_BEARER_TOKEN` is configured and Hosted Observability Proof run `26594855907` on 2026-05-28 (`cb04c708`) uploaded artifact `hosted-observability-proof-26594855907` with validation `status: "ok"`. The artifact proves unauthenticated `/metrics` returned `401` and the scraper-token request returned `200`. |
| Sentry/logging decision | Proofed | Same Hosted Observability Proof run `26594855907` validated the v1 `log_only_deferred` Sentry posture and sampled structured backend logs from `docker logs agent-backend --tail 200`; the captured line was a JSON `http.response` record with string log level `info`. `sentryReadyObserved` is `false` because backend Sentry remains intentionally deferred for v1. |
| Alert destination | Proofed | Same Hosted Observability Proof run `26594855907` sent one deliberate hosted smoke failure to `ops-alerts` through the configured webhook. The sanitized artifact records `deliberateFailureDelivered: true` and message/correlation id `github-observability-alert-26594855907-1`. |
| Operator self-report evidence | Done | `Hermes Operator Report` workflow schedules and manually runs `ops_health` and `daily_operator_brief` through Hermes with correlation IDs, step summaries, and 90-day artifacts. Production proof: operator report run `26211100734` on 2026-05-21 produced artifacts `hermes-operator-report-ops_health-26211100734-1` and `hermes-operator-report-daily_operator_brief-26211100734-1`, both `success`, with no obvious secret patterns found in downloaded evidence. Post-deploy proof run `26241427864` uploaded artifact `hermes-post-deploy-26241427864`. Hosted bootstrap instrumentation proof run `26241544177` passed `CHECK_BOOTSTRAP_INSTRUMENTATION=1` against live `ADMIN_JWT`; the log reached `Checking bootstrap instrumentation` and ended with `Hosted stack smoke check passed.` Branded email delivery remains optional/deferred. |
| Dispute verdict hosted proof | Proofed | Live hosted proof captured in `docs/evidence/dispute-verdict-proof-2026-05-27.json` against synthetic dispute `dispute-e03d8e28d9d6` / chain job `0x46519cdd46ce82dccff06907c750c625c8f3fa2537ec855cfe02966586c593aa`. The hosted verdict route persisted `status=resolved`, `verdict=upheld`, `reasonCode=DISPUTE_LOST`, `chainStatus=confirmed`, `reasoningHash=0xf8c954af95e826be07815775e801c3d12341c156d55fc9cf9548db635dc4e55c`, and metadata URI `urn:averray:content:0xf8c954af95e826be07815775e801c3d12341c156d55fc9cf9548db635dc4e55c`; the persisted dispute matches the verdict response. Paseo Asset Hub TestNet emitted `DisputeOpened` tx `0x46d33967d7ce63813c71619cfd858a401f61fdd2d191a9d1f77eec8d6405375b` at block `9386778` and `DisputeResolved` tx `0x3632c402966de8bf7dda55fb88627a9fa1019d9a867017008cf02b2ce02d7472` at block `9387753`; the final `EscrowCore.jobs(...)` state is `Closed`. This closes the hosted proof workflow that wraps `CHECK_DISPUTE_VERDICT_PROOF=1` / `DISPUTE_PROOF_LIVE=1` in a production GitHub Actions gate with explicit `live=true` confirmation and a sanitized artifact. Polkadot docs MCP check remains unchanged: official Polkadot Hub smart-contract docs confirm REVM/Solidity contract support; this row records hosted proof evidence, not a protocol semantics change. |
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
| Dispute/arbitration semantics | Proofed | Hosted dispute `dispute-e03d8e28d9d6` proves the dispute/arbitration contract end to end: reads expose SLA state, allowed verdicts, canonical reasoning hash/URI requirements, release readiness/reason, and the split between verdict submission and post-verdict operator release receipt; the live verdict recorded `release.ready=true`, `release.reason=verdict_recorded`, and `timeline[].action=verdict_submitted` with confirmed tx `0x3632c402966de8bf7dda55fb88627a9fa1019d9a867017008cf02b2ce02d7472`. `docs/evidence/dispute-verdict-proof-2026-05-27.json` includes the arbitrator-notification rehearsal via the hosted `dispute.verdict_recorded` event/operator drawer contract, covering SLA, release readiness, allowed verdicts, reasoning hash/URI, authority labels, timeout semantics, and confirmed chain tx evidence. Polkadot docs MCP check remains unchanged: Hub explorers expose transaction/status/metadata history for smart-contract activity, and content-addressed storage docs confirm hash/CID-style records are the right shape for immutable reasoning references; this item changes API/SDK/UI semantics only, not chain behavior. |
| Timeline operator UX verification | Done | Backend trace filters landed, and the operator app exposes URL-backed job timeline filters for source, topic, phase, severity, wallet, and correlation ID. Session drawer reuses the same controls client-side for session movement review. Evidence: `app/components/runs/TimelineEventFilters.tsx`, `app/components/runs/JobTimelinePanel.tsx`, `app/app/(authed)/sessions/page.tsx`, `app/components/sessions/SessionDrawerBody.tsx`, `app/lib/api/hooks.ts`, `mcp-server/src/protocols/http/server.js`, and `mcp-server/src/core/platform-service.test.js`. |
| Reference-agent workflow generalization | Done | General workflow pattern documented in `docs/REFERENCE_AGENT_WORKFLOWS.md` for GitHub, dependency/OSV, open-data, OpenAPI, standards, and Wikipedia job families; anchored to existing claim, submit, schema, and timeline surfaces. |

### Control-Room UI Review Intake (2026-05-27)

Source fragment: [`roadmap-updates/control-room-ui-observations-2026-05-27.md`](./roadmap-updates/control-room-ui-observations-2026-05-27.md). These rows are planning intake only: none is `Done` or `Proofed` until implementation evidence and the verification path below pass. The review session that triaged this fragment did not have authenticated live-UI access, so A1, A3, and A7 are blocked on human/live verification instead of being treated as confirmed drift.

| Item | Status | Owner | Lane | Close criteria | Verification path |
| --- | --- | --- | --- | --- | --- |
| A1 — Runs asset denomination reconciliation | Blocked | Operator / docs steward | USDC settlement truth | Verify whether the live Runs page still displays job cost in DOT. If drift is confirmed, reopen the relevant USDC settlement/plumbing status claim with concrete evidence; if intentional, add the split rationale to `AVERRAY_WORKING_SPEC.md` and ship an in-UI explanation. | Authenticated live UI check on Runs page plus screenshot or operator note; if drift, add API/job evidence showing current asset source. |
| A2 — Receipts and badges metric clarity | Done | Frontend | receipts / reputation trust surface | Receipts top metric is now labeled `Receipt ledger` and shows the kind breakdown (`run`, `badge`, `settle`, `policy`) instead of reading as a badge-only total; Agents aggregate now labels its count `Badge receipts` with `verified outcomes only` copy. | UI contract and helper coverage in `app/lib/ui/receipt-metrics.test.mjs`; app typecheck/build run in the implementing PR. |
| A3 — Capabilities admin state reconciliation | Blocked | Operator / frontend | capability grants | Verify whether the signed-in admin/verifier wallet is failing a stricter capability-management role check or whether the Capabilities page ignores authenticated state. If stricter role is intentional, clarify the required role in the UI/spec; if bug, reopen the relevant capability-grants/status claim with evidence. | Authenticated admin-wallet live UI check plus `/auth/session`/capability evidence or screenshot. |
| A4 — Overview first-load orientation | In review | Frontend | operator onboarding / reputation deepening | A signed-in operator whose room has no activity yet sees a slim, dismissable next-step card above the vitals hero; it points to the first useful action ("Browse open runs"), stays gone once dismissed, and auto-hides once the room has activity. Scope note: unauthenticated visitors never reach `/overview` (AuthedGuard redirects them to `/sign-in`), so the unauth orientation lives on the sign-in page instead. | Implemented: `app/components/overview/OrientationCard.tsx` (mounted/hydration-safe, localStorage dismissal that persists) wired into `app/app/(authed)/overview/page.tsx` above `MissionHero`. Show/hide logic is the tested pure module `app/lib/ui/overview-orientation.js` (+ `overview-orientation.test.mjs`, 7 cases). Truth-boundary: the card only renders once the activity requests (jobs/sessions/badges) have **resolved** and the combined count is `0` — a loading room never renders as empty, so the card can't flash in then vanish. Complementary unauth orientation added to `app/app/sign-in/page.tsx` (a scannable "What you'll do here" — the prior copy only covered SIWE mechanics). `npm run test:app` (incl. new suite), `typecheck:app` + `build:app` green. **Remaining:** screenshot/state-fixture proof of the empty-room card appearing and the dismiss persisting. |
| A5 — Sidebar count badge consistency | In review | Design steward / frontend | sidebar polish | **Decision: attention-only counts.** A left-rail badge appears ONLY where the number is an action signal an operator triages on — `/runs` (open/claimable jobs), `/sessions` (in-flight sessions: active/submitted/disputed), `/disputes` (open disputes). Receipts, Agents, Policies, Capabilities, and Audit log intentionally carry **no** count (a raw total/roster there is noise, and the audit log grows unbounded). This also fixes the prior inconsistency where wired counts (Policies/Disputes) silently vanished on certain data shapes/load states. | Applied in `app/components/shell/OperatorRail.tsx` via a tested pure helper `app/lib/ui/sidebar-counts.js` (+ `sidebar-counts.test.mjs`, 4 cases). Open-dispute logic mirrors `dispute-adapters.ts` `stateFor()` + the Disputes page "Open disputes" metric (`state !== "resolved"`); in-flight-session logic mirrors `session-adapters.ts` `state()`. Truth-boundary: each helper returns `undefined` while loading/unrecognized so the rail never renders a confident `0` — a real `0` ("queue clear") only shows once data is present and is visually distinct from "didn't load". Removed the dead inline `countOf`/`activeClaimCount` helpers and the now-unused Agents/Badges/Policies fetches from the rail. `npm run test:app` (incl. new helper suite), `typecheck:app` + `build:app` green. **Remaining:** screenshot across sidebar surfaces on live data. |
| A6 — Provider Operations operator-language pass | Done | Frontend | overview comprehension | Overview provider-operation rows now render a four-term operator legend (`Found upstream`, `Opened as jobs`, `Safely ignored`, `Needs attention`), derive readable last-run summaries from the backend counters, and relabel skip details as `ignored because`. | Component contract and helper coverage in `app/lib/ui/provider-operation-language.test.mjs`; app typecheck/build run in the implementing PR. |
| A7 — Treasury DOT borrow-capacity / USDC debt reconciliation | Blocked | Operator / docs steward | treasury / capital clarity | Verify whether DOT borrow capacity with USDC debt is intentional architecture or USDC-plumbing drift. If intentional, add rationale to `AVERRAY_WORKING_SPEC.md` and an in-UI explanation; if drift, reopen the relevant USDC settlement/plumbing status claim with evidence. | Authenticated live Treasury check plus screenshot/API state for capacity, debt asset, and related account position. |
| C1 — Chain explorer link on chain-anchored entities | In review | Frontend | trust-surface / reputation deepening | Every page that displays a genuine chain-anchored tx/block exposes a small explorer link that lands on the correct environment-specific explorer view. Scope clarified: only values whose *provenance* is a real on-chain anchor are linked. | Implemented: shared `app/lib/chain/explorer.js` (Subscan + Blockscout registry keyed by `NEXT_PUBLIC_CHAIN_ENV`; unset → Paseo TestNet default, unknown → fail-closed no link) + `app/components/common/ExplorerLink.tsx`, wired into the Disputes drawer (replaces a hardcoded `assethub-polkadot.subscan.io` link that pointed operators at **mainnet** while we run on TestNet) and the Runs job timeline (`event_bus` `txHash`/`blockNumber`). Truth-boundary: Sessions `tx` and Receipts "Block ref" are deliberately NOT linked — their value is a `chainJobId` (bytes32, shape-identical to a tx hash but not explorer-resolvable); the "Block ref" mislabel is a separate follow-up. Capabilities/agents/treasury/audit carry no genuine anchor. Evidence: `app/lib/chain/explorer.test.mjs` asserts testnet (`assethub-paseo.subscan.io`) + mainnet (`assethub-polkadot.subscan.io`) URL fixtures; live resolution confirmed for real dispute tx `0x3632…d7472` at `https://assethub-paseo.subscan.io/tx/0x3632c402966de8bf7dda55fb88627a9fa1019d9a867017008cf02b2ce02d7472` (Subscan renders the Revive Eth_transact, block 9387753, status Success), cross-checked via Blockscout `/api/v2/transactions`. `npm run test:app` 55/55, `typecheck:app` + `build:app` green. Explorer URLs verified against polkadot-docs MCP (`smart-contracts/explorers.md`, `connect.md`). **Remaining:** live authenticated UI screenshot of the rendered link on Disputes + Runs. |
| C2 — Shareable read-only view URLs | Open | Frontend / backend | reputation deepening / distribution | At least three shareable surfaces generate signed read-only URLs with expiry, and those URLs render correctly without operator auth. | Incognito/browser test for agent profile, session/audit trail, and dispute/policy snapshot; signature/expiry verification. |
| C3 — Verify Signature and Verify Manifest end-to-end | Open | Frontend / backend | receipts / audit verification | Existing Verify Signature and Verify Manifest buttons are proven real end-to-end for at least one real receipt and one real audit manifest, or escalated to implementation work if they are placeholders. | Hosted or local proof script/screenshot showing input, verification result, and reproducible fixture IDs. |
| C4 — Cross-agent reputation comparison | Open | Frontend | reputation deepening | Agents directory supports selecting two or three agents and opening an exportable side-by-side comparison. | UI test/screenshot showing comparison with tier, score, badges, and recent activity. |
| C5 — Inline rejected/slashed rationale | Open | Frontend / backend | disputes / sessions clarity | Rejected, slashed, or disputed sessions show the citing policy and linked receipt inline without forcing a deep click path. | Session/dispute fixture or hosted screenshot showing the policy violation and receipt link. |
| C6 — Agent directory to public profile bridge | In review | Frontend | reputation deepening / trust-surface | Every agent row links to the public profile at `averray.com/agents/<wallet>` (plural — the deployed Caddy convention; the earlier `/agent/` wording was imprecise) and the public profile renders the same reputation/badge data as the internal row. | Public profile page already exists and is deployed: `site/agent.html` + `site/agent.js` (hand-maintained in `site/`; the marketing sync only regenerates `index.html`/`_astro`/`console-stream.js`). It hydrates from `GET https://api.averray.com/agents/<wallet>` — the SAME public API the internal directory row consumes — so reputation/badges match by construction, with honest loading/not-found/empty states. This PR adds the missing bridge: a shared, tested `app/lib/agents/public-profile.js` builder (validates `0x{40}`, lowercases, fail-closed `null` so no link is emitted that the Caddy `^/agents/(0x[a-fA-F0-9]{40})/?$` rewrite won't match), a per-row `Public profile ↗` link in `AgentDirectoryTable.tsx` (stops propagation so the row's drawer still opens), and reuse of the builder in `AgentDrawerBody.tsx` (null-safe `PublicIdentityCard`). Test `app/lib/agents/public-profile.test.mjs` asserts the built path matches the deployed Caddy matcher + fail-closed cases; added `app/lib/agents/*.test.mjs` to `test:app`. `npm run test:app` 52/52, `typecheck:app` + `build:app` green. **Remaining:** live browser click-through from a real agent row to the rendered public profile. **Follow-up filed:** `site/agent.js` hardcodes mainnet Subscan (`assethub-polkadot.subscan.io`) for its on-chain links — same mainnet-on-testnet class as the C1 disputes fix, but on the public site. |
| C7 — Policy/capability "what changed" surface | Open | Frontend / backend | governance / audit-remediation polish | Policies and Capabilities pages show recent changes with before/after diffs and click-through from the index page. | UI test/screenshot with seeded policy/capability revisions and diff view. |
| C8 — Global control-room search | Deferred | Frontend | v2 quality-of-life | Cmd-K or equivalent search queries at least four entity types and navigates to selected entities. | Future v2 implementation proof with results for receipt/session/agent/policy or audit entries. |

B1-B5 remain design-backlog opinions in the source fragment. They are not committed roadmap work until the owner approves a design pass.

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
| External audit | Open | Run `npm run prepare:mainnet-audit-freeze -- --tag audit/mainnet-YYYY-MM-DD --create-tag --evidence docs/evidence/mainnet-audit-freeze-YYYY-MM-DD.json --json`, push the frozen tag, hand auditors [`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md), complete review of contracts, backend money routes, verifier/auth/control routes, and ops runbooks, then fix or explicitly accept every Critical/High finding before real funds. Close only after the final report names the reviewed commit/tag and remediation PRs. |
| Fresh mainnet multisig | Open | Mainnet owner multisig created with hardware-backed signers. |
| Mainnet contract deploy | Open | Escrow, treasury/account, policy, verifier, registry, and related contracts deployed from audited artifacts. |
| Ownership transfer | Open | Deploy key transfers ownership to multisig as first post-deploy action. |
| Role assignment | Open | Verifier, arbitrator, pauser, and service operators configured and rehearsed. |
| Mainnet asset config | Ready for proof | Static guard `scripts/ops/check-mainnet-usdc-config.mjs --env deployments/mainnet.env.example` validates the launch env against the canonical Polkadot-docs-backed USDC config: Trust-Backed Asset ID `1337`, 6 decimals, ERC20 precompile `0x0000053900000000000000000000000001200000`, no ERC20 metadata functions, and the conservative raw launch parameters. Close after the operator captures `mainnet-usdc-asset-config-v1` runtime evidence from Polkadot Hub mainnet and reruns the same script with `--runtime-evidence ... --require-runtime`. Polkadot docs MCP check: `smart-contracts/precompiles/erc20.md` confirms the Trust-Backed precompile address format/core ERC20 subset and `reference/polkadot-hub/assets.md` confirms USDC asset ID `1337`, 6 decimals, and sufficiency. |
| Mainnet env/secrets | Ready for proof | New offline guard `scripts/ops/check-mainnet-env-secrets-proof.mjs --file docs/evidence/mainnet-env-secrets-YYYY-MM-DD.json --max-completed-age-hours 24 --json` validates a redacted `mainnet-env-secrets-proof-v1` artifact for mainnet env/profile, canonical mainnet RPC, final non-zero contract addresses, fresh role signers, multi-region KMS blockchain/JWT signers via IAM Roles Anywhere, no HMAC/raw-key/static-AWS fallback, mainnet-only service-token scopes, and no testnet secret reuse. Close after the operator captures the real private mainnet env/secrets evidence from the deployed configuration and the guard passes. |
| Mainnet smoke | Ready for proof | New offline guard `scripts/ops/check-mainnet-smoke-proof.mjs --file docs/evidence/mainnet-smoke-YYYY-MM-DD.json --max-completed-age-hours 24 --json` validates a redacted `mainnet-smoke-proof-v1` artifact for at least three low-value mainnet claim -> submit -> approved verification -> confirmed settlement runs. The guard requires canonical Polkadot-docs-backed USDC (`assetId: 1337`, 6 decimals, Trust-Backed precompile `0x0000053900000000000000000000000001200000`, `minBalanceRaw: 70000`), mainnet-only URLs/RPC/explorer links, final non-zero contract addresses, short-lived scoped auth instead of long-lived admin JWTs, unique run/job/session IDs, confirmed chain tx hashes, badge/profile verification, timeline traces, no direct Wikipedia edit claim, and no secret-looking payloads. Close after the operator captures the real mainnet evidence from three low-value smoke runs and the guard passes. Polkadot docs MCP check: `smart-contracts/precompiles/erc20.md`, `reference/polkadot-hub/assets.md`, and `smart-contracts/explorers.md`. |
| Incident response | Ready for proof | New offline guard `scripts/ops/check-incident-response-proof.mjs --file docs/evidence/incident-response-YYYY-MM-DD.json --max-completed-age-hours 24 --require-mainnet --json` validates a redacted `incident-response-proof-v1` artifact covering on-call contacts, P1/P2/P3 drills, hosted alert delivery and green restore, validated live pause/unpause evidence, backend/indexer/frontend rollback rehearsal, owner-signer escalation, post-incident capture, and no secret-looking payloads. Close after the operator captures the real mainnet rehearsal evidence and the guard passes. Polkadot docs MCP check: `smart-contracts/explorers.md` confirms explorer support for transaction status/history metadata, and `smart-contracts/for-eth-devs/accounts.md` confirms native account mapping requirements for Hub smart-contract interactions. |

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

As of 2026-05-28:

- Open issues in `averray-agent/agent`: none.
- Open PRs in `averray-agent/agent`: none.

## Immediate Work Queue

1. Track the Stage 2C-3 HMAC retirement window: ≥30 days after the 2026-05-21
   KMS-only JWT cutover, delete `op://prod-backend/auth-jwt-secrets`, drop the
   HMAC code branch from `mcp-server/src/auth/jwt.js`, and retire
   `AUTH_JWT_SECRETS` from the secrets inventory + calendar.
2. Operator: act on `PHASE_4E_PLAN.md` § 7 decision points (one vs two
   operators, registrar identity + FIDO2 support, GitHub org-2FA member
   audit before flipping enforcement) before procuring YubiKeys.
3. Keep native XCM/vDOT work behind the staging evidence gate and week-12
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
