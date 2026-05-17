# Operator Onboarding

This is the first document an operator reads before taking ownership of any
Averray production-adjacent surface. It is intentionally a routing document:
the *executions* live in the runbooks this doc cross-references. The point of
this file is to make sure a new operator knows which runbooks to read in
which order, what access they need to acquire first, and which trust
boundaries they are responsible for.

If you are doing day-1 incident triage, jump to
[`INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md). Come back here when the
incident is closed.

## 1. Who this is for

This doc is for any human who will:

- hold a 2-of-3 multisig signer key for `TreasuryPolicy.owner`
- hold the hot pauser key for `TreasuryPolicy.setPaused`
- take primary or backup on-call for `ops@averray.com`
- run a manual `workflow_dispatch` against the **Deploy Production** workflow
- ship a contract or backend change that affects money-like routes, async
  XCM settlement, discovery manifest publish, or the multisig control plane

It is **not** for end-users of the platform (workers, posters, external
agents). Those have their own onboarding surfaces:
[`AGENT_WALLET_ONBOARDING.md`](./AGENT_WALLET_ONBOARDING.md) and
[`EXTERNAL_AGENT_WALLET_ONBOARDING.md`](./EXTERNAL_AGENT_WALLET_ONBOARDING.md).

## 2. Before you start

Have these in place before you begin reading the runbooks:

- **1Password access.** Confirm you can resolve `op://prod-backend/`,
  `op://prod-backend-external/`, `op://prod-ci/`, and `op://prod-indexer/`
  vault items via `op item get`. See
  [`SECRETS.md`](./SECRETS.md) for the vault map and
  [`SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md) for the Phase 3 KMS
  cutover history.
- **GitHub repo access** on `averray-agent/agent` with at least Read
  on Actions and Secrets, and Write on the working branch namespace
  (`agent/<task-name>`, `codex/<task-name>`, or `claude/<task-name>` per
  [`AGENTS.md`](../AGENTS.md)).
- **VPS SSH access** for production-adjacent debugging. Production
  deploys go through `.github/workflows/deploy-production.yml`; do not
  SSH into production unless an incident demands it. See
  [`VPS_RUNBOOK.md`](../VPS_RUNBOOK.md).
- **AWS access for the KMS signer** if you are taking signer-rotation
  duty. The backend uses `SIGNER_BACKEND=kms` since the 2026-05-16
  Phase 3 cutover; verifying the live signer requires
  `scripts/ops/derive-kms-signer-address.mjs` and
  `scripts/ops/verify-kms-signer.mjs`.
- **A clean development checkout.** Multi-agent work uses one worktree
  per task — run `./scripts/ops/start-agent-worktree.sh
  <prefix>/<task-name>` from the primary repo root and never work in
  the primary checkout. See [`AGENTS.md`](../AGENTS.md) for the
  branching rules.

If any of the above is missing, stop and acquire it before continuing.

## 3. Read these first, in this order

1. [`AGENTS.md`](../AGENTS.md) — branching, worktree, PR-shape, and
   deployment rules. The shortest of the documents listed here and the one
   most likely to be misapplied if skimmed.
2. [`THREAT_MODEL.md`](./THREAT_MODEL.md) — the operational risks every
   role inherits. Read every section, not just the ones that look
   relevant — the threats compose.
3. [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) — the canonical
   list of what production-readiness means. The boxes are the test;
   flipping one requires deployed evidence, not a doc edit.
4. [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) — the multisig design and
   rehearsal procedure. If your role touches `TreasuryPolicy.owner`,
   read this end-to-end.
5. [`INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md) — what to do when
   something breaks. §1 lists the on-call routing and ownership; §6 has
   per-symptom playbooks.
6. [`AUDIT_REMEDIATION.md`](./AUDIT_REMEDIATION.md) — the active
   multi-agent remediation board. The packages on this board are the
   tracked work for closing the v1.0.0-rc1 trust-boundary findings.
   Treat it as a coordination contract; only edit your own package's
   status.

Architecture context (read once, refer back as needed):

- [`AVERRAY_WORKING_SPEC.md`](./AVERRAY_WORKING_SPEC.md) — the design.
- [`AVERRAY_VERIFICATION_LEDGER.md`](./AVERRAY_VERIFICATION_LEDGER.md) —
  what's empirically verified against Polkadot vs. what's still
  unconfirmed.
- [`FRAMEWORK_AGENT_HANDOFF.md`](./FRAMEWORK_AGENT_HANDOFF.md) — the
  implementation-side handoff that sits between the spec and the live
  code. Mirrors most of the routing here, but from the
  framework-developer angle.

## 4. First-time setup walkthrough

Run these in order. Each step ends with a check you can use to confirm
the setup is wired.

### 4.1 Confirm your 1Password access

```bash
op item get aws-signer-testnet --vault prod-backend --fields kms-key-id
```

Expected: the `kms-key-id` value resolves without prompting for a vault
unlock. If you see "permission denied" or "vault not found", your
service-account token is not scoped correctly — see
[`SECRETS.md`](./SECRETS.md) §"Vault scopes" before continuing.

### 4.2 Confirm the env templates render

```bash
./scripts/ops/validate-env-render.sh backend
./scripts/ops/validate-env-render.sh indexer
```

Expected: both exit `0` after resolving every `op://` reference. A
failure here means an upstream 1Password rotation has not been mirrored
into the templates yet — surface in `#ops` before deploying.

### 4.3 Confirm the multisig owner record

```bash
jq '{status, threshold, signatories: [.signatories[].address]}' \
  deployments/testnet-multisig-owner.json
```

Expected: `status: "verified"`, `threshold: 2`, and three SS58
signatory addresses. If you are joining as a new signatory, see
[`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §2 to generate your key and
§4 to map it into the EVM-side owner.

### 4.4 Confirm the live signer address

The production backend signs with a KMS-derived EVM address, not a
raw private key (Phase 3 cutover 2026-05-16). To see which address
production is currently signing as:

```bash
node scripts/ops/derive-kms-signer-address.mjs
```

Expected: the same address that `TreasuryPolicy.verifiers` lists as
`true` on chain. If they diverge, the multisig
`setVerifier(address, true)` did not land — surface immediately, do
not deploy.

### 4.5 Confirm hosted health

```bash
./scripts/ops/check-hosted-stack.sh
```

Expected: green across the four public surfaces (`averray.com`,
`api.averray.com`, `index.averray.com`, `app.averray.com`). A red
result here is the day-1 thing to fix before any other work.

## 5. Day-to-day duties

### 5.1 The deploy ritual

Every backend or frontend change reaches production through
`.github/workflows/deploy-production.yml`. Two trigger paths:

- **Auto** — `workflow_run` after CI completes successfully on `main`.
  This is the normal path. `PRODUCT_PROOF_REQUIRE_WORKER_LOOP=0`; no
  worker-loop is attempted.
- **Manual** — `workflow_dispatch` from the Actions UI. Honors the
  caller's `product_proof_require_worker_loop` input. Read
  [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) §13 before
  setting that input to `1`; a misconfigured signer balance will fail
  the loop and leave the production lock unfree for the next caller.

After a deploy: confirm `./scripts/ops/check-hosted-stack.sh` is green
and the GitHub Actions summary contains a Hermes post-deploy
verification report.

### 5.2 The smoke ritual

```bash
./scripts/ops/check-hosted-stack-and-alert.sh
```

This is the production-side smoke check. If `ALERT_WEBHOOK_URL` is set,
the failure path delivers to that webhook. Schedule this on an external
cron so a hung deploy gets noticed within minutes, not hours. See
[`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) §5 for the
verification recipes that flip the §5 observability boxes.

### 5.3 The discovery manifest publish

The discovery manifest hash is anchored on-chain via
`DiscoveryRegistry.publish(hash)`. The
`.github/workflows/publish-discovery-manifest.yml` workflow runs after
every production deploy and publishes only if the served manifest hash
differs from the on-chain hash. To trigger manually:

```bash
gh workflow run publish-discovery-manifest.yml \
  -R averray-agent/agent --ref main
```

Expected: `published` or `already_current` in the job log. A failure
here is operationally noisy but not fund-affecting; investigate but do
not panic.

### 5.4 The audit-prep posture

External audit is not yet engaged. The audit-firm-facing scope docs are:

- [`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md) — v1 contracts + off-chain
  attention points
- [`STRATEGY_ADAPTER_AUDIT_SCOPE.md`](./STRATEGY_ADAPTER_AUDIT_SCOPE.md)
  — separate engagement for the real strategy adapter when it ships

Both docs cite `<pkuriger@averray.com>` (primary) and `<ops@averray.com>`
(escalation) as the audit-firm contact addresses. When you take audit
ownership, confirm those addresses route to you and update if they do
not.

## 6. Recovery playbooks

These exist as separate documents; this section is just the routing
table.

| Scenario | Where to go |
|---|---|
| Pause needed (incident) | `INCIDENT_RESPONSE.md` §3 + `MULTISIG_SETUP.md` §7 |
| Pauser key compromise | `MULTISIG_SETUP.md` §7 (rotate pauser via multisig) |
| Owner-multisig signer lost | `MULTISIG_SETUP.md` §7 (3-of-3 multisig recovery) |
| Backup/restore drill | `BACKUP_RESTORE_DRILL.md` |
| `/content/:hash` 404 after Redis incident | `CONTENT_RECOVERY_RUNBOOK.md` |
| Async XCM request stuck pending | `ASYNC_XCM_STAGING.md` + `NATIVE_XCM_OBSERVER.md` |
| Signer USDC empty (manual deploy fails) | `PRODUCTION_CHECKLIST.md` §13 + `TESTNET_FUND_SIGNER.md` |
| Discovery manifest publish stale | `.github/workflows/publish-discovery-manifest.yml` (manual dispatch) |

## 7. What is intentionally out of your hands

These things you should NOT do solo as an operator, even if you have
the access:

- **Mainnet contract deploy.** The contract suite is currently testnet-only.
  Mainnet deploy requires external audit sign-off
  ([`AUDIT_PACKAGE.md`](./AUDIT_PACKAGE.md) §9 deliverable) AND a
  rehearsed multisig rehearsal of [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §5
  end-to-end.
- **Owner-multisig threshold change.** `TreasuryPolicy.owner` is a
  2-of-3 multisig per [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §1.
  Changing the threshold means a multi-day multisig coordination
  effort; do not propose it casually.
- **Direct on-chain mutation outside `EscrowCore` / `AgentAccountCore`
  flows.** The backend signer is KMS-backed for exactly this reason —
  bypass with a raw key only in a documented incident, never as a
  shortcut.

## 8. Signing off as a new operator

You are operationally ready when:

- [ ] You can resolve every 1Password reference your role requires
- [ ] You have run `./scripts/ops/check-hosted-stack.sh` against the live
  stack and seen a green result
- [ ] You have rehearsed pause + unpause from the pauser key (see
  [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §5)
- [ ] You have rehearsed at least one owner-only admin operation from
  your multisig signer (see [`MULTISIG_SETUP.md`](./MULTISIG_SETUP.md) §5)
- [ ] You are reachable at the operator alias
  (`ops@averray.com` per [`INCIDENT_RESPONSE.md`](./INCIDENT_RESPONSE.md) §1)
- [ ] You have read this document and the six it cross-references at the
  top of §3

If any box stays unchecked, you do not have full operator readiness
yet. Reach out to the existing on-call before taking solo ownership of a
production-adjacent action.
