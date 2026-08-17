# Averray Unified Project Roadmap

- **Status date:** 2026-06-16
- **Baseline reviewed:** `origin/main` at `fb6a558`
- **Latest docs audit:** [`DOCS_AUDIT_2026-05-19.md`](./DOCS_AUDIT_2026-05-19.md)
- **Purpose:** one status and roadmap page for the specs, audits, launch
  checklists, security plans, and product-proof work.
- **Recent window:** since the 2026-05-28 baseline (`39ab1b8`), ~89 commits have
  landed (through `fb6a558`). Headline events: the first fully-settled
  external-agent loop (2026-06-13), the autonomous self-driving loop
  (2026-06-15, now **paused on signer liquidity**), and a pre-audit security
  sweep (2026-06-16, 8 findings remediated — **not** the external audit). See
  Current Product Posture and the Blockchain/Mainnet section.

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

## Product Positioning — Outcome Assurance · RATIFIED 2026-08-17

Adopted 2026-08-17 (Pascal) from an external strategy read, cross-checked against
the platform's actual state before ratification. This section owns product
framing; detailed sequencing lives in `OUTCOME_PIVOT_BUILD_PLAN.md` on branch
`claude/packets-2026-08-12`.

**The sentence:** Averray is the outcome-assurance layer for autonomous work —
it verifies the result, releases the money, and leaves a portable receipt.
Agents can promise; Averray proves and pays.

This is a repackaging, not a rebuild. The 2026-08-13 Witness pivot already made
verification the platform's internal center of gravity, and the paid-verification
x402 shelf (#237) was independently ratified the same morning this proposal
arrived. Zero new contracts are required; the marketplace, lanes, canary, and
credit ladder keep operating unchanged underneath.

### Four product surfaces (progression: Verify → Pay → Fulfill → Route → Finance)

1. **Averray Verify** — independent outcome verification. The customer brings
   the artifact or endpoint; Averray runs a named, versioned verifier profile
   and issues a work receipt. First x402 shelf product (absorbs #237).
2. **Averray Proof-to-Pay** — outcome-bound settlement, bring-your-own-
   counterparty. The customer brings both sides; escrow releases on `PASS` only.
   Removes the marketplace cold-start: a company can use Averray with no need
   for Averray's worker supply.
3. **Averray Fulfill** — the existing marketplace, presented as optional
   sourcing behind the two front doors ("Do you already have a provider?").
4. **Averray Trust Graph** — the receipt graph behind routing, exposure,
   pricing, and credit underwriting. Credit, deposits, badges, valves, and bonds
   become downstream capabilities, not competing front doors.

### The atomic object: the work receipt

Every surface emits the same receipt — four sections (intent / execution /
verification / settlement), each mapped to evidence that already exists
(specHash F1–F4, git-bundle source binding, verifier version, settlement tx,
dispute status). The one missing atom is the canonical object itself plus its
public page (`PACKET_WORK_RECEIPT`, the keystone build). Verdict vocabulary:
`PASS` / `FAIL` / `INCONCLUSIVE` (new backend state; no settlement action,
routes to human/dispute) / `PLATFORM_FAULT` (preserves
`workerConsequence: none`).

### North-star metric

**External verified outcomes settled per week** — strictly excluding
operator-funded work, canary, acceptance wallets, protocol demonstrations,
self-paid revenue, and synthetic traffic. Computable today via the
SelfIdentityRegistry + poster-side classification (#1147): a board query, not a
project. Deposits, TVL, total jobs, badges minted, and gross receipts are
secondary until external demand repeats.

### Vocabulary law

*Outcome verification / work verification / proof-to-pay / work receipt.* Never
"certification", never "AI agent verification" (ERC-8126 owns that term for
security-posture checks), never unbounded "safe" badges — a receipt states
"endpoint X passed profile Y version Z against evidence root R on date D" and
nothing broader. Truth-boundary applies to marketing: **"Averray Verify"
appears on no public page until a stranger can actually buy a run.**

### The 30-day experiment (supersedes the "20 qualified poster conversations" back half of `ECONOMIC_STRATEGY.md` §7; due date unchanged, 2026-09-11)

Launch Verify with three profiles (`git-patch-tests-v1`,
`mcp-failure-semantics-v1`, `structured-output-evidence-v1`), each producing the
same receipt and a public receipt page; add one Proof-to-Pay pilot with a
customer-supplied provider.

Outreach re-segmented (19 of 20 conversations remaining): 8 MCP/agent-tool
operators · 6 devtool/OSS maintainers · 6 agent-platform builders who already
delegate work. The ask changes from "would you post on an agent marketplace" to
**"what result are you currently paying an agent, API, or contractor to produce
where payment is disconnected from objective proof that it worked?"**

Success criteria by 2026-09-11 (the signal is repeat payment, not compliments):
10 outsiders submit a real artifact or endpoint; 5 complete a paid verification
run; 3 run a second paid run without manual persuasion; ≥1 uses Proof-to-Pay
with its own provider; median setup < 15 minutes; every external run cleanly
separated from operator/canary traffic; ≥1 customer embeds or shares the
receipt in its own workflow.

Kill-or-narrow conditions: fewer than 3 of 20 qualified prospects submit a real
artifact; customers only value a free badge; most requested outcomes cannot be
stated as a bounded verification policy; integration needs a custom project per
customer; the receipt goes unused after the scan.

### What freezes and what continues

Frozen (all already gated — the freeze adds no new constraint): L3 stays
flag-off until an L2 cohort self-amortizes; Rail-2 pool-venue credit stays
Swiss-memo-gated; no general agent-directory ambition (enrich ERC-8004-class
directories with outcome evidence instead); Hermes stays the ops-truth system,
not a trace/eval platform; subjective-work scale-out waits on T5; chain-first
marketing (sell verified outcomes, not "a Polkadot marketplace").

Continues unchanged: the scheduled L1 credit lifecycle (first draw 2026-08-18),
the L2 deploy ceremony when gated, the §8 multisig batch, the canary, the
curated lanes (they are the receipt factory and the liveness proof), and
external-audit engagement.

New urgency: the **Swiss memo is now the binding gate for the flagship product**
and should be scoped Proof-to-Pay-first, deposits second — releasing
third-party money against a policy is the exact activity the memo must cover.
No new custody class is created (external poster funds already flow through
escrow since the poster door opened 2026-08-08; BYO only changes who the buyer
names as recipient), but scaling it is memo-gated.

Deferred with explicit gates (detail in the build plan): receipt-based routing
API (≥50 external receipts); validator/verification-recipe marketplace (three
Averray-operated profiles with repeat paying customers first); receipt warranty
(measured invalid-receipt rate over a real corpus plus legal review —
fee-refund scope only, never job-value indemnification).

## Current Product Posture

> **Positioning note (2026-08-17):** product framing is now owned by the
> Product Positioning — Outcome Assurance section above. The posture text below
> is the June 2026 testnet-era snapshot, kept for history; the mainnet cutover
> happened 2026-07-27 (see the Immediate Work Queue refresh notes).

Averray is currently a **testnet product-proof platform**. The core backend,
operator app, public discovery/trust surfaces, schema-native job path, USDC
settlement route, service-token capability primitives, and product-proof worker
loop have all landed. The first fully-settled product loop ran on testnet on
2026-06-13 (real external agent: claim → submit → verify → settle, 2 USDC reward,
PRO badge). The autonomous self-driving loop (auto-verify + settle, zero operator,
via `#633` auto-verify and `#643`/`#635` ingestion-prefund) was proven end-to-end
on 2026-06-15, but is **PROVEN-BUT-PAUSED-ON-LIQUIDITY** as of 2026-06-16: the
Hosted Worker Canary is RED on `settlementReady=false` because the backend signer
EOA has 0 USDC. It is not currently live/settling.

It is **not yet mainnet real-funds ready**. A 2026-06-16 pre-audit security
sweep found 8 findings (3 HIGH / 2 MED / 2 LOW / 1 INFO) plus invariant-9, all
remediated via `#649`–`#656`; this was a **pre-audit pass, not the external
audit**. The external audit remains **OPEN** and is the hard gate before mainnet
real funds. Mainnet readiness still requires that external audit, mainnet
custody/secrets setup, mainnet contract deployment, control-plane rehearsals,
production observability, backups/restore proof, and final launch gates.

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
| [`MAINNET_CREDENTIALS_PLAN.md`](./MAINNET_CREDENTIALS_PLAN.md) | Mainnet credential/key inventory (fresh-vs-reuse), ordered provisioning runbook, and friction reducers for the real-funds launch. |
| [`THREAT_MODEL.md`](./THREAT_MODEL.md) | Launch threat model and security posture. |
| [`RC1_WORKING_SPEC.md`](./RC1_WORKING_SPEC.md) | Historical only. |
| [`RC1_IMPLEMENTATION_PLAN.md`](./RC1_IMPLEMENTATION_PLAN.md) | Historical rc1 slice tracker. Keep for old acceptance criteria only. |

## Completed Foundations

| Area | Status | Evidence |
| --- | --- | --- |
| Trust-core product model | Done | Current working spec v2.14 locks receipts, reputation, no token, USDC-only v1. |
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
| KMS JWT migration through Stage 2C-2 | Done | Six stages live in prod: **Stage 1** (`JWT_BACKEND=both`, `#430`) — verifier accepts HS256 + ES256; **Stage 2A** (`#432`) — SIWE + `/auth/refresh` route through `signTokenFromConfig`; **Stage 2B** (`#433`) — multi-role ES256 (`roles: [...]` array claim); **Stage 2B activation** (`#434`) — `JWT_PRIMARY_ALG=kms` flipped, SIWE actively mints multi-role ES256 against the KMS key; **Stage 2C-1** (`#438`) — `signServiceToken` migrated to dispatcher with `roles: ["service"]`; **Stage 2C-2** (`#439`, merged 2026-05-21) — `JWT_BACKEND` flipped `both` → `kms` in `deploy/backend.env.template`, so the prod verifier now refuses HS256. End-to-end verified in prod (admin+verifier wallet returns 48 capabilities via `/auth/session`). Remaining: only Stage 2C-3 HMAC code-path retirement (deferred ≥30d after 2C-2; HS256 verify branch + `AUTH_JWT_SECRETS` still present). |

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
| B1 — Sparkline signal clarity | Open | Design / frontend | metric-trend readability | Decide whether small sparklines are meaningful enough to keep. If kept, add readable trend context such as hover values, visible delta, and a clear time window; if not, replace decorative-only sparklines with a compact last-7-days delta. Scope starts with Overview vitals, Agents directory/aggregate, Treasury balance cards, and Receipts KPI cards. | Backlog generated from `roadmap-updates/control-room-ui-observations-2026-05-27.md` B1. Implementation proof should include screenshots or component tests showing at least Overview + Agents trend cards expose either meaningful sparkline context or explicit delta text, with no decorative-only trend glyphs left in scope. |
| C1 — Chain explorer link on chain-anchored entities | In review | Frontend | trust-surface / reputation deepening | Every page that displays a genuine chain-anchored tx/block exposes a small explorer link that lands on the correct environment-specific explorer view. Scope clarified: only values whose *provenance* is a real on-chain anchor are linked. | Implemented: shared `app/lib/chain/explorer.js` (Subscan + Blockscout registry keyed by `NEXT_PUBLIC_CHAIN_ENV`; unset → Paseo TestNet default, unknown → fail-closed no link) + `app/components/common/ExplorerLink.tsx`, wired into the Disputes drawer (replaces a hardcoded `assethub-polkadot.subscan.io` link that pointed operators at **mainnet** while we run on TestNet) and the Runs job timeline (`event_bus` `txHash`/`blockNumber`). Truth-boundary: Sessions `tx` and Receipts "Block ref" are deliberately NOT linked — their value is a `chainJobId` (bytes32, shape-identical to a tx hash but not explorer-resolvable). The "Block ref" mislabel follow-up has since landed (PR #596, commit `4454a62`): Receipts now renders the value as "Escrow job" (`app/lib/api/receipt-adapters.ts:135`) and Sessions tags it as a provenance-typed `ChainRef` via `classifyChainReference` (`app/lib/api/session-adapters.ts`), with the `isLinkableChainReference` seam in `app/lib/chain/chain-reference.js` keeping a chainJobId unlinked. Capabilities/agents/treasury/audit carry no genuine anchor. Evidence: `app/lib/chain/explorer.test.mjs` asserts testnet (`assethub-paseo.subscan.io`) + mainnet (`assethub-polkadot.subscan.io`) URL fixtures; live resolution confirmed for real dispute tx `0x3632…d7472` at `https://assethub-paseo.subscan.io/tx/0x3632c402966de8bf7dda55fb88627a9fa1019d9a867017008cf02b2ce02d7472` (Subscan renders the Revive Eth_transact, block 9387753, status Success), cross-checked via Blockscout `/api/v2/transactions`. `npm run test:app` 55/55, `typecheck:app` + `build:app` green. Explorer URLs verified against polkadot-docs MCP (`smart-contracts/explorers.md`, `connect.md`). **Remaining:** live authenticated UI screenshot of the rendered link on Disputes + Runs. |
| C2 — Shareable read-only view URLs | In review | Frontend / backend | reputation deepening / distribution | Signed, expiring read-only share URLs now cover four surfaces: agent profiles, session audit trails, dispute snapshots, and policy snapshots. Authenticated operators create shares through `POST /shares`; unauthenticated viewers resolve snapshots through `GET /shares/:token` and the public `/share` app page. | Implemented: HMAC share-token helper + tests (`mcp-server/src/core/share-links.js`), HTTP share routes + tests (`mcp-server/src/protocols/http/share-routes.js`), public no-auth viewer (`app/app/share/page.tsx`), and copy-link controls on Agents/Sessions/Disputes/Policies. **Remaining:** hosted incognito/browser proof for agent, session, and dispute/policy snapshots after deploy; production must set `SHARE_URL_SECRET` or rely on the auth signing secret. |
| C3 — Verify Signature and Verify Manifest end-to-end | In review | Frontend | receipts / audit verification | Receipt verification is no longer a placeholder: the drawer accepts a detached `averray.receipt.signature.v1` JSON envelope, rebuilds the canonical evidence hash from the displayed receipt JSON, checks the envelope hash/receipt id, and verifies the EVM signature with `viem` `verifyMessage`. Receipts and Audit log now both expose real manifest verification controls that rebuild deterministic manifest payloads from the current live view and detect hash drift instead of rendering disabled/export-only affordances. | Evidence: `app/lib/ui/evidence-verification.js` + `evidence-verification.test.mjs` cover canonical JSON, real EVM signer recovery for fixture `r_c3_real_receipt_001`, tamper rejection, and audit manifest fixture `audit-c3-manifest-001`; `npm run test:app`, `npm run typecheck:app`, and `npm run build:frontend` green. **Remaining:** authenticated browser screenshot of the receipt signature result + audit manifest verifier on hosted or local data. |
| C4 — Cross-agent reputation comparison | In review | Frontend | reputation deepening | The Agents directory now has a per-row compare checkbox (cap 3). Selecting 2–3 agents reveals a compare bar; "Compare →" opens a side-by-side dialog showing tier, reputation score, specialty, badges, recent activity, stake (deposited/locked), 30d slashes, and sub-contracting lineage, with an "Export CSV" download. | Implemented: `app/components/agents/AgentComparisonDialog.tsx` (Radix `Dialog`), selection state + compare bar in `app/app/(authed)/agents/page.tsx`, checkbox column in `AgentDirectoryTable.tsx` (click stops row-drawer propagation; unchecked boxes disabled at the cap). Comparison rows + RFC-4180 CSV serializer are the tested pure module `app/lib/ui/agent-comparison.js` (+ `agent-comparison.test.mjs`, 8 cases). Truth-boundary: empty/missing metric values render an em-dash (never a fake blank/0); badge ids resolve to human labels via `BADGES`. `npm run test:app` (incl. new suite), `typecheck:app` + `build:app` green. **Remaining:** UI screenshot of a live 2–3 agent comparison + CSV. |
| C5 — Inline rejected/slashed rationale | In review | Frontend / backend | disputes / sessions clarity | Rejected, slashed, or disputed sessions now derive a shared `outcomeRationale` from verifier/dispute metadata and render the citing policy plus linked receipt inline in Sessions and Disputes table rows/drawers. | Implemented in `app/lib/ui/outcome-rationale.js`, `app/components/common/OutcomeRationaleInline.tsx`, `app/lib/api/session-adapters.ts`, `app/lib/api/dispute-adapters.ts`, Sessions/Disputes pages and drawers. Pure helper coverage in `app/lib/ui/outcome-rationale.test.mjs`; `npm run test:app`, `npm run typecheck:app`, and `npm run build:frontend` green in the implementing PR. **Remaining:** hosted/session-dispute screenshot showing the policy violation and receipt link. |
| C6 — Agent directory to public profile bridge | In review | Frontend | reputation deepening / trust-surface | Every agent row links to the public profile at `averray.com/agents/<wallet>` (plural — the deployed Caddy convention; the earlier `/agent/` wording was imprecise) and the public profile renders the same reputation/badge data as the internal row. | Public profile page already exists and is deployed: `site/agent.html` + `site/agent.js` (hand-maintained in `site/`; the marketing sync only regenerates `index.html`/`_astro`/`console-stream.js`). It hydrates from `GET https://api.averray.com/agents/<wallet>` — the SAME public API the internal directory row consumes — so reputation/badges match by construction, with honest loading/not-found/empty states. This PR adds the missing bridge: a shared, tested `app/lib/agents/public-profile.js` builder (validates `0x{40}`, lowercases, fail-closed `null` so no link is emitted that the Caddy `^/agents/(0x[a-fA-F0-9]{40})/?$` rewrite won't match), a per-row `Public profile ↗` link in `AgentDirectoryTable.tsx` (stops propagation so the row's drawer still opens), and reuse of the builder in `AgentDrawerBody.tsx` (null-safe `PublicIdentityCard`). Test `app/lib/agents/public-profile.test.mjs` asserts the built path matches the deployed Caddy matcher + fail-closed cases; added `app/lib/agents/*.test.mjs` to `test:app`. `npm run test:app` 52/52, `typecheck:app` + `build:app` green. **Remaining:** live browser click-through from a real agent row to the rendered public profile. **Follow-up filed:** `site/agent.js` hardcodes mainnet Subscan (`assethub-polkadot.subscan.io`) for its on-chain links — same mainnet-on-testnet class as the C1 disputes fix, but on the public site. |
| C7 — Policy/capability "what changed" surface | In review | Frontend / backend | governance / audit-remediation polish | Policies and Capabilities pages now expose a shared `What changed` card. Policies use seeded v3 -> v4 history for `claim/deps-sec-only` and open the drawer directly on the before/after revision diff; Capabilities list issued/revoked grants and show the before/after diff inline. | Implemented in `app/lib/ui/governance-changelog.js`, `app/components/governance/WhatChangedPanel.tsx`, `app/app/(authed)/policies/page.tsx`, `app/components/policies/PolicyDrawerBody.tsx`, `app/app/(authed)/capabilities/page.tsx`, and `mcp-server/src/core/builtin-policies.js`. Checks: `npm run test:app`, `npm run typecheck:app`, `npm run build:app`, `npm --workspace mcp-server test`. **Remaining:** authenticated UI screenshot with seeded policy/capability revisions and both diff paths visible. |
| C8 — Global control-room search | Deferred | Frontend | v2 quality-of-life | Cmd-K or equivalent search queries at least four entity types and navigates to selected entities. | Future v2 implementation proof with results for receipt/session/agent/policy or audit entries. |

B2-B5 remain design-backlog opinions in the source fragment. B1 has been promoted to an Open design/frontend backlog row; the remaining items are not committed roadmap work until the owner approves a design pass.

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
- Pre-audit security review (2026-06-16): an in-house adversarial sweep of the autonomous-settlement surface found 8 findings (3 HIGH / 2 MED / 2 LOW / 1 INFO) plus invariant-9, all remediated — `#649` (self-heal mined-but-receipt-lost submits + bounded retry, findings #2/#4), `#650` (dispute payouts in base units), `#651` (gate `AgentAccountCore` settlement to escrow), `#652` (idempotent `verifySubmission` across a post-payout persist failure, #5), `#653` (serialize `submitWork` on the session lock, #6), `#654` (fail closed on permissive `AUTH_MODE` + live gateway, #7), `#655` (redact credential-looking tokens from provider errors, #8), `#656` (gate the net-reward haircut to native-gas reward assets, invariant-9); plus `#648` (nonReentrant strategy-lifecycle entrypoints). **This was a pre-audit pass, not the external audit — the external audit (Blockchain/Mainnet section below) remains the hard gate before mainnet real funds.**
- Deploy-pipeline hardening (2026-06-16, `#657`): the Hermes post-deploy verification step is now advisory, not a deploy gate. Context: `avg-hermes` crash-looped on an `/opt/data/skills` volume permission (root-owned `0700` vs the UID-10000 Hermes user), reddening Deploy Production for hours and skipping the worker canary, while `api.averray.com/health` stayed 200. Fixed by a host `chown` + `#657` (a non-zero Hermes result now emits a `::warning::` and exits 0). The Hosted Worker Canary remains the **hard** gate for the brokered claim/submit/settle path; pre-deploy 1Password-validation gates are untouched.
- Go-live P2 ops tooling: a standalone API-only claim-readiness smoke (`#658`, `scripts/ops/api-readiness-smoke.mjs` — SIWE → `/account` → preflight → optional `/admin/status`, read-only, no Docker/Hermes/chain RPC) and zero-exposure key provisioning for the admin-EOA rotation (`#659`, `--write-to-op` passes the key as a discrete `execFile` argv element — no shell, no echo, no command-line placeholder, no shell history).

### In Flight

- **Worker-loop refresh-flow** — shipped in PR #529. `ADMIN_JWT`
  30-day-manual-rotation path retained for backward compatibility; retire
  after a 30-day soak period proves the refresh path stable in CI.
- **CloudTrail/CloudWatch KMS signing alarms** — CloudFormation foundation shipped in PR #532 (`deploy/iac/cloudwatch/kms-signing-alarms.yaml`); proof-format follow-up shipped in PR #590 (read-only validator `scripts/ops/check-kms-cloudwatch-alarm-proof.mjs` + operator flow in `deploy/iac/cloudwatch/README.md`). Adds a CloudFormation alarm foundation for blockchain/JWT KMS signing, auth failure anomalies, refresh replay detection, and structured `kms.sign.duration` logs. Close after the stack is deployed with baseline-derived thresholds, a sanitized `docs/evidence/kms-cloudwatch-alarms-YYYY-MM-DD.json` artifact validates against the #590 guard, and an alert-channel proof reaches the operator channel.

### Remaining

- **Hardware MFA for admin chain accounts** — Ready for proof. Validator script `scripts/ops/check-hardware-mfa-evidence.mjs` (`#487`) validates `hardware-mfa-evidence-v1` JSON artifacts covering 1Password admin, AWS root, AWS IAM admins, GitHub org admin, domain registrar, and OVH/VPS provider. Close after a sanitized `docs/evidence/hardware-mfa-YYYY-MM-DD.json` artifact validates and the operator confirms recovery paths without storing raw recovery codes in Git. Full enrollment plan in [`PHASE_4E_PLAN.md`](./PHASE_4E_PLAN.md).
- **HMAC retirement (Stage 2C-3 cleanup)** — ≥30 days after 2026-05-21: delete `op://prod-backend/auth-jwt-secrets`, drop the HMAC code branch from `mcp-server/src/auth/jwt.js`, retire `AUTH_JWT_SECRETS` from the secrets inventory + rotation calendar. Dispatcher already refuses HS256 at the verifier level since 2C-2; this is cleanup of unused config/code.
- **Phase 5a-retire** — ≥30 days after 2026-05-21: `aws iam delete-access-key` for the static keys still in 1Password (`op://prod-backend/aws-signer-testnet`, `op://prod-backend/aws-jwt-signer-testnet`), delete the `access-key-id` + `secret-access-key` 1Password fields. Backend already runs entirely on Roles Anywhere — this removes the static-key rollback escape hatch once Roles Anywhere is proven stable.
- Mainnet multi-region KMS from day one.

## Blockchain And Mainnet Roadmap

### Testnet State

- Polkadot Hub TestNet is the active proving environment.
- Owner multisig exists and is verified.
- KMS verifier signer is active.
- USDC testnet funding, approval, deposit, claim, submit, and settlement have
  all been proven through the product-proof worker loop (first fully-settled
  external-agent loop 2026-06-13).
- The self-driving loop (auto-verify + auto-settle, zero operator) was proven
  on 2026-06-15 via `#633` auto-verify+settle, `#634` CI worker canary,
  `#643` ingestion-prefund, and `#644` admin/verifier allowlist rotation off
  the leaked key. It is currently **PROVEN-BUT-PAUSED-ON-LIQUIDITY** (2026-06-16):
  the hosted Worker Canary is RED on `settlementReady=false` because the backend
  signer EOA's USDC balance is depleted (signer `0x31ad` EOA USDC = 0, admin
  `0x6778` = 0.2 per operator brief). The loop resumes on a signer top-up, not
  new code.

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

## Trust Primitives — The Agent-Labour Gaps

Workshopped 2026-08-10. Each row was checked against the code before being written
down, because three of the six turned out to be further along than the framing
suggested and one is essentially finished. A roadmap that restates shipped work is
worse than no roadmap.

| # | item | actual state |
|---|---|---|
| T1 | Bonds and slashing | **Done, live on mainnet.** |
| T2 | Arbitration | **Built, does not scale.** |
| T3 | Delegation and authority | **Partly specified.** |
| T4 | Subcontracting graphs | **Designed, deliberately gated.** |
| T5 | Fair exchange | **Open for subjective work only.** |
| T6 | Credential brokering | **Absent, and a posture decision.** |

### T1 — Bonds and slashing · DONE

`EscrowCore` carries `claimStake` with `claimStakeBps`; `AgentAccountCore` exposes
`slashJobStake(account, asset, amount, posterRecipient)`, `releaseJobStake`, and
`slashClaimFee(…, verifierRecipient)`. The live board advertises
`claimBond { stakeBps: 1000, feeBps: 200 }` — a 10% bond scaled to job value, slashed
on an upheld ruling. "Collateral not receipts" is the mechanism we already run, not
an ambition. Nothing to build; the open question is whether the bond should scale
with reputation rather than only with job value, which belongs with the reputation
pricing work.

### T2 — Arbitration · BUILT, DOES NOT SCALE

`EscrowCore.resolveDispute(jobId, workerPayout, reasonCode, metadataURI)` is live,
with three verdicts — dismissed, upheld, and **split** (partial payout chosen by the
arbitrator) — ES256-signed verdict receipts, and a full path exercised end to end in
August 2026.

So the keystone exists. **The gap is that one human is the judge.** Two distinct
pieces of work follow, and they are not the same size:

- **Scale the judgment.** Model juries with staked votes, so quality assessment does
  not queue behind one person. Schema validation catches shape, never quality — that
  part of the framing is right and it is why `human_fallback` exists at all.
- **An appeals path.** There is none. A verdict is final, which is defensible at
  today's volume and indefensible at any other.

### T3 — Delegation and authority · PARTLY SPECIFIED

More exists than "TreasuryPolicy is the seed". Job definitions already accept a
`delegationPolicy` with `maxDepth`, `maxSubJobs`, and `budgetAmount` (validated at or
below the reward, asset-matched), plus a `lineage` field. So the authority *ceiling*
for delegated work is specified today.

**What is absent is revocation.** "Revocable how fast" has no answer, and that is the
question an enterprise actually asks. `TreasuryPolicy.dailyOutflowCap` exists but is
deliberately unarmed (`type(uint256).max` on mainnet), so the spend ceiling is
declared rather than enforced.

### T4 — Subcontracting graphs · DESIGNED, GATED

This is rung 5 of `BANK_DEPOSIT_PRODUCT_DESIGN.md`, and the gate is deliberate: *"Do
not start it before rungs 1–4 are stable."* Nested escrow, liability flowing up the
tree, atomic settlement across a DAG, payment splits. `delegationPolicy` and
`lineage` are the seeds already in the catalogue.

Probably the highest-value item here, and the one most likely to be started too
early. Liability chains are the hard part, not the plumbing.

**A2A is the protocol T4 implements**, and it appeared nowhere in this roadmap until
now — it was tracked only in `AGENT_BANKING.md`'s "What's missing". A2A's own
literature names the hard part of agent marketplaces as *"identity, reputation,
billing, compliance, sandboxing, liability, versioning, and dispute resolution"*,
which is very nearly an inventory of what already exists here. That is the version
worth building: **A2A with real money under it**, not an A2A badge on a manifest.

> **Standing rule — do not re-add `a2a` to public discovery until the endpoint, auth
> posture and docs all exist.** Live discovery advertises `["http", "mcp"]` and that is
> correct.
>
> The tempting shortcut is a "truthful partial" Agent Card. **There is no such thing.**
> `protocolVersion` declares the A2A version supported *at that interface*, not the
> version of the spec you read, and §12.1 requires a custom binding to implement **all**
> A2A core operations — so any card published claims full core support. PR #1008 tried
> exactly this and was closed. The recommendation behind it rested on a *summarised*
> fetch of the spec rather than the normative text, and was used to argue past the rule
> in `AGENT_BANKING.md` that turned out to be right.
>
> The general shape, worth remembering beyond A2A: **the cheap version of a standard is
> a claim, the valuable version is a mechanism.** Only the second earns anything.

### T5 — Fair exchange · OPEN FOR SUBJECTIVE WORK ONLY

The classic problem — a buyer cannot evaluate a deliverable without receiving it, and
once received can refuse to pay — **we partly sidestep by design.** The buyer does not
decide. A verifier does, and the escrow pays on its verdict.

That dissolves the problem for objectively checkable work and leaves it fully intact
for everything else, which is exactly where `human_fallback` routes today. So the
honest scope is not "unsolved" but **"solved for the deterministic share, unsolved for
the rest"** — and the rest is a third of the live board.

Commit-reveal, partial disclosure and TEE attestation of properties without revealing
content are the candidate mechanisms. Genuinely hard, genuinely unsolved industry-wide,
and defensible if we crack it.

### T6 — Credential brokering · ABSENT, AND A POSTURE DECISION

Agents need API keys and OAuth tokens to do real work: scoped, ephemeral, revoked at
job close, with an audit trail. Nobody has done this well and it is immediately
painful.

**It also cuts against a standing boundary.** Today agents bring their own credentials
and we never hold them — the money rail is deliberately the only thing we custody.
Brokering scoped tokens makes us a credential custodian, which is a materially
different security posture and threat model, and it widens the blast radius of any
compromise from "funds we hold" to "every system our agents can reach."

Worth wanting. But it is a decision about what kind of company we are, not only a
feature, and it should be taken as one.

### Sequencing note

T1 is done. T2's appeals path is small and overdue. T3's revocation gap is what an
enterprise asks about first. T4 is gated behind the deposit-pool rungs and should stay
gated. T5 and T6 are research and posture respectively, and neither should displace
the demand-side work — none of these fixes a board that no external agent has yet
evaluated.

### Interop — agentic-commerce standards · OPEN, ADDED 2026-08-17

Two external reads (AWS/OpenAI "Controlled agentic commerce with AgentCore Payments";
The Graph "Understanding x402 + ERC-8004") triggered this section. The control patterns
they teach — bounded sessions, approval mandates, idempotent payment proofs, model-never-
touches-keys, merchant-acceptance ≠ settlement-finality — are patterns this platform
already runs with on-chain proof, which is citable validation, not work. The work is
interop and distribution:

1. **ERC-8004 presence (near-term, actionable).** The Graph now publishes the ERC-8004
   identity/reputation/validation registries across 8 chains with canonical APIs (Agent0
   partnership) — consumption infrastructure our early-August "nobody reads it" finding
   predates. Register Averray and verified agents (the acceptance wallet carries a real
   badge and settlement history) in the identity/reputation registries; re-verify which
   deployments are canonical first. Tracked as session task #236.
2. **ERC-8004 validation writer (strategic).** The validation registry ("proof of
   correct task execution") is what our verification contract and the Witness produce.
   Exporting validation attestations positions Averray as trust infrastructure inside
   the emerging standard — "sell the rail, not the board" made concrete. Evaluate after
   the presence step; do not build before demand evidence.
3. **Mandate-vocabulary compatibility (cheap, next credit-surface iteration).** Enrich
   the L2/L3 SIWE consent schema with the AgentCore `ApprovalGrant` field shape —
   purpose, resource binding, approver identity, expiry — so agent-poster builders
   raised on that vocabulary recognize our consent object without translation.
4. **x402 seller shelf (demand-side, pairs with outreach track 2).** AgentCore trains a
   buyer population that spends over x402; we are an x402 merchant with no shelf. List
   our payable endpoints where x402 buyers discover sellers; evaluate paid reads
   (reputation, verification results) beyond job posting.

Ideas file, not this month: GraphTally-style settlement batching against our measured
~0.118 DOT/settlement gas burn.

**Decisions 2026-08-17 (Pascal):** registration scope = Averray platform identity + the
flagship verified agent, on Base, receipt-backed claims only; validator-role trigger =
observed consumption, instrumented as registry-referred endpoint traffic + on-chain events
touching our entries (reads emit nothing — this proxy is the instrument); consent schema
takes the full ApprovalGrant vocabulary with approver as an optional, unenforced field;
first x402 shelf product = paid verification runs (packet #237), coherent with free
registry reputation and the on-ramp to the validator role. **2026-08-17 evening:**
#237 is absorbed into the Averray Verify shelf — see Product Positioning — Outcome
Assurance; Averray work receipts become the payload for the validation-writer step.

## Current Open PRs And Issues

As of 2026-06-16:

- Open issues in `averray-agent/agent`: none.
- Open PRs in `averray-agent/agent`: #660 (Dependabot npm_and_yarn group bump, opened 2026-06-16, base `main`).

## Immediate Work Queue

**Additions 2026-08-17 (agentic-commerce interop — details in the Interop subsection
above):** (a) ERC-8004 registry presence for Averray + verified agents (#236); (b) x402
seller shelf for the AgentCore-trained buyer population; (c) ApprovalGrant field
vocabulary into the next L2/L3 consent-surface iteration. Also worth naming so this
queue doesn't lie by omission: since the 2026-08-13 refresh below, EscrowCore v3 shipped
and was proven live (first retention + poster-fee charges and the cancelOpenJob path,
2026-08-16), the credit L2/L3 pilot merged with the CW-1..9 amendments (sweep-based
deduction now, AAC-next creditBroker banked — superseding the v4-payout-router line
below), and the arrivals ours/outsider split shipped. Full trail on branch
`claude/packets-2026-08-12`.

**Additions 2026-08-17, evening (outcome-assurance pivot — see Product
Positioning above; sequencing in `OUTCOME_PIVOT_BUILD_PLAN.md` on
`claude/packets-2026-08-12`):** (d) `PACKET_WORK_RECEIPT` — canonical work
receipt schema + public receipt page (the keystone; first build); (e) the
Averray Verify shelf — three verifier profiles, x402 fixed pricing,
`INCONCLUSIVE` verdict state (absorbs item (b) above and #237); (f)
`PACKET_PROOF_TO_PAY` — bring-your-own-counterparty agreements: designated-
claimant gate, pilot caps, existing poster fee; (g) outreach re-segmentation
8/6/6 with the outcome-assurance ask; (h) Swiss memo rescoped
Proof-to-Pay-first; (i) GitHub issue-to-bounty product, gated behind the first
external paid verification run.

**Refreshed 2026-08-10.** The previous list had gone stale in a way worth naming: item
1 asked for a *testnet* signer top-up to unpause a loop, and item 2 framed the external
audit as "the hard gate before mainnet" — we cut over to mainnet on 2026-07-27. A queue
that describes a world we have left is worse than an empty one.

1. **Watch for the first genuinely external arrival.** 500 reaches, 5 external browses,
   **zero evaluations**. That is the actual bottleneck and nothing else on this list
   moves it. Blocked on the arrivals split counting our own inspection sessions as
   external — the client name identifies the MCP software, not the operator.
2. **Stop sweeping our own board.** One wallet holds 8 of 11 claims, stamped within
   nine minutes, on the operator-brokered starter path. To an arriving agent the market
   reads as farmed. Making our worker the buyer of last resort — claiming only jobs
   unclaimed for N minutes — is hours of work and removes a deterrent we built.
3. **Engage the external audit.** Still the right thing, no longer a pre-mainnet gate.
   `npm run prepare:mainnet-audit-freeze`, push the frozen tag, hand auditors
   [`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md).
4. **Bank lane — pool LIVE, ladder COMPLETE, fee schedule RATIFIED (refreshed 2026-08-13).**
   The 2026-08-10 text below this point described a blocked world that no longer exists;
   full paper trail on branch `claude/packets-2026-08-12`.
   - **DepositPool deployed 2026-08-12** (`0xCCF5FDF3…F476`, cost-basis pricing — the #1066
     fix — caps 1,000/100) with the wired lane, door (#1099/#1101), observability (#1098),
     and the first deposit (10 USDC, dogfood wallet). Operating rule until the Swiss memo:
     **capped, quiet, disclosed** — the disclosure line ships on every `/pool` response and
     the hosted smoke fails without it (#1102).
   - **Worker ladder: all four valves live.** S global tier-0 subsidy (#1074), E per-wallet
     open exposure (#1079), D rolling daily exposure (#1086), and tier-3 — first wired 1:1
     (#1095), then **superseded by the D0 vested-capacity model (#1103, live 2026-08-13)**
     after external economic review: catalogue access is deposit-blind (lifetime credit
     until 10-settled-job graduation, then a deposit-blind daily base, all under a global
     rolling catalogue budget); vested deposits (48h linear, LIFO burn on withdrawal) buy
     open-exposure raises and external-job reward ceilings instead
     (`PACKET_D0_VESTING.md`).
   - **Fee schedule ratified 2026-08-13** on measured gas (`GAS_STUDY_2026-08-13.md`,
     `PACKET_D4_FEE_SCHEDULE.md`): worker-side gas retention `min(0.05, 20%)` iff brokered,
     external poster fee `max(5%, 0.05)`, schedule admin-settable behind contract ceilings.
     **EscrowCore v3 is in build** (`PACKET_ESCROWCORE_V3_SPEC.md`, dispatched 2026-08-13);
     the ceremony also ships the banked `cancelOpenJob` (2026-08-01 decisions) and starts
     the v1/v2 decommission.
   - **Credit layer ratified 2026-08-13** (`CREDIT_LAYER_DESIGN.md`, CL-1..CL-5): in-payroll
     lending — receipt-graph underwriting, settlement-deduction repayment. First build:
     CreditPool + L1 secured lines against vested deposits, which **requires a DepositPool
     v2 pledge surface** — scheduled as the next pool window after the v3 ceremony, while
     migration still costs nothing (single depositor, ours)
     (`PACKET_CREDITPOOL_L1_SPEC.md`). L2 waits for the v4 payout-router window; the
     pool→credit venue rail stays memo-gated.
   - Still open in this lane: epoch-2 yield ceremony on the pool lane (legs A–C ready via
     `pool-venue-ceremony.mjs`; if the DepositPool v2 window is near, fold epoch-2 into
     post-migration rather than deploying venue capital that the migration must first
     recall), 30-day review gates due 2026-09-11 (`ECONOMIC_STRATEGY.md` §7).

5. **Stage 2C-3 HMAC retirement window.** ≥30 days after the 2026-05-21 KMS-only JWT
   cutover: delete `op://prod-backend/auth-jwt-secrets`, drop the HMAC branch from
   `mcp-server/src/auth/jwt.js`, retire `AUTH_JWT_SECRETS` from the inventory and
   calendar.
6. **Operator: `PHASE_4E_PLAN.md` §7 decision points** — one vs two operators, registrar
   identity and FIDO2 support, GitHub org-2FA member audit — before procuring YubiKeys.

Trust primitives T1–T6 sit above; none of them is in this queue, because none of them
fixes a board no external agent has yet evaluated.

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
