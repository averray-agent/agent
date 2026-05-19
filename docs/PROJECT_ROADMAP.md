# Averray Unified Project Roadmap

- **Status date:** 2026-05-19
- **Baseline reviewed:** `origin/main` at `163bd76`
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

## Status Terms

- **Done:** merged to `main` and represented in the current deployed or
  deployable product surface.
- **Proofed:** done and backed by a hosted smoke, real workflow, chain proof, or
  durable operator evidence.
- **Open:** not implemented, not fully verified, or still blocked by an
  operational prerequisite.
- **Deferred:** intentionally out of v1 or blocked on a later phase gate.

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
| [`PHASE_4B_STAGE_2C_PLAN.md`](./PHASE_4B_STAGE_2C_PLAN.md) | Current KMS JWT cutover plan. |
| [`SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md) | Secrets and custody migration history and mainnet requirements. |
| [`THREAT_MODEL.md`](./THREAT_MODEL.md) | Launch threat model and security posture. |
| [`RC1_WORKING_SPEC.md`](./RC1_WORKING_SPEC.md) | Historical only. |
| [`RC1_IMPLEMENTATION_PLAN.md`](./RC1_IMPLEMENTATION_PLAN.md) | Historical rc1 slice tracker. Keep for old acceptance criteria only. |

## Completed Foundations

| Area | Status | Evidence |
| --- | --- | --- |
| Trust-core product model | Done | Current working spec v2.10 locks receipts, reputation, no token, USDC-only v1. |
| USDC settlement baseline | Done | Contracts and product-proof path use USDC Trust-Backed Asset ID 1337. |
| Product-proof worker loop | Proofed | Hosted proof in `PRODUCT_PROOF_GATE.md`, GitHub Actions run `25988470399`, 2026-05-17. |
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
| KMS JWT migration through Stage 2C-1 | Done | Route-level signer dispatcher landed in `#438`. |

## Open Work To RC1/Testnet Launch

These are the remaining items before calling the hosted testnet platform
externally ready.

### P0 Launch Gates

| Item | Status | Close criteria |
| --- | --- | --- |
| Control-plane pauser | Open | `TreasuryPolicy.pauser` is a hot key with only pause power, recorded in deploy docs. |
| Pause/unpause rehearsal | Open | Rehearse pause and unpause from pauser key and record tx hashes in `PRODUCTION_CHECKLIST.md`. |
| Postgres backup readiness | Open | `check-backup-readiness.sh --json` reports recent Postgres backup. |
| Redis backup readiness | Open | `check-backup-readiness.sh --json` reports recent Redis backup if Redis contains non-rebuildable state. |
| Restore drill | Open | Restore drill performed and documented with date, source backup, and target. |
| Hosted `/admin/status` async XCM smoke | Open | Run hosted check with live admin JWT and verify async XCM watcher lane. |
| Metrics auth | Open | Backend metrics endpoint is bearer-protected or otherwise not public. |
| Sentry/logging decision | Open | Backend Sentry configured or explicitly deferred; frontend decision recorded; structured logs visible. |
| Alert destination | Open | At least one deploy/health failure path reaches the operator. |
| Operator self-report evidence | Open | Hermes/operator report proof replaces optional Resend email proof. Evidence should include correlation ID and durable destination. |
| Dispute verdict hosted proof | Open | Hosted smoke creates a dispute verdict receipt or documented equivalent. |
| Public discovery/schema/trust gate | Open | Hosted gate proves deployed public pages and API mirror match current behavior. |
| Canonical public discovery/API mirror | Open | Public mirror is checked by product-proof smoke or equivalent hosted workflow. |

### P1 Product And Platform Hardening

| Item | Status | Close criteria |
| --- | --- | --- |
| HTTP server route split (`P2.3`) | Open | Split high-risk route groups out of the monolith without changing behavior; add route-level tests. |
| Frontend auth guard (`P3.7`) | Open | Authenticated app layout has a real guard/401 flow and cannot show misleading authed shells. |
| Verifier replay hardening | Open | Split verifier policy version from config version and require handler-versioned fixtures before v2 handler changes. |
| Schema registration for external jobs | Open | Custom/off-platform references can register signed schemas with clear trust boundaries. |
| Dispute/arbitration semantics | Open | Decide release path, store arbitrator reasoning under content hash, expose dispute UI fields, and rehearse arbitrator notifications. |
| Timeline operator UX verification | Verify | Backend trace filters landed; confirm the operator app has the intended visible filters and close the item if already merged. |
| Reference-agent workflow generalization | Open | Wikipedia one-command workflow exists; general workflow pattern should be documented for other job families. |

## Auth, Secrets, And Capability Roadmap

### Completed

- Service-token capability model and primitives.
- Scoped service-token proof route.
- Refresh-cookie auth flow.
- KMS-backed verifier signer on testnet.
- KMS JWT migration through Stage 2C-1: route-level signer dispatcher.

### In Flight

| PR / Work | Status | Notes |
| --- | --- | --- |
| `#439` Stage 2C-2: `JWT_BACKEND=both` to `kms` | Draft/open | Do not merge until `#438` has deployed and soaked for at least 24 hours, service-token proof stays green, no new `jwt_verify_failed`, and admin/verifier `/auth/session` is confirmed. |
| `#440` Phase 4e plan | Open/review-ready | Docs-only plan for hardware MFA and adjacent mainnet-prep security. |

### Remaining

- Stage 2C-3 HMAC retirement after KMS-only soak period.
- Remove or disable HMAC verifier path once retirement criteria pass.
- Hardware MFA for admin chain accounts, GitHub, AWS, Cloudflare/Vercel, domain registrar, and emergency email.
- Replace static AWS access keys with IAM Roles Anywhere or equivalent workload identity.
- Mainnet multi-region KMS from day one.
- Worker-loop refresh-flow so hosted smokes do not depend on manually rotated 30-day admin JWTs.
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
    verification criteria.
  - `#440` review-ready docs: Phase 4e hardware MFA and mainnet-prep security
    plan.

## Immediate Work Queue

1. Review and merge `#440` if the Phase 4e plan is acceptable.
2. Keep `#439` draft until `#438` has soaked and the service-token/auth checks
   pass under `JWT_BACKEND=both`.
3. Close the remaining `PRODUCTION_CHECKLIST.md` P0 launch gates:
   pauser/rehearsal, backups, restore drill, `/admin/status` hosted check,
   metrics/logging/alerts, self-report evidence, dispute verdict proof, and
   public discovery/schema/trust proof.
4. Open or assign narrow PRs for `P2.3` route split and `P3.7` frontend auth
   guard if no existing agent owns them.
5. Keep native XCM/vDOT work behind the staging evidence gate and week-12
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
