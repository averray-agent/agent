# Production Readiness Checklist

> Current roadmap/status source: [`PROJECT_ROADMAP.md`](./PROJECT_ROADMAP.md).
> This checklist remains the operator go/no-go gate for launch readiness.

This is the operator-facing gate for promoting Averray from a healthy
testnet deployment into something we can treat like a real production
service. It complements:

- [ASYNC_XCM_STAGING.md](./ASYNC_XCM_STAGING.md) for the current async
  treasury rehearsal flow
- [VPS_RUNBOOK.md](../VPS_RUNBOOK.md) for day-to-day hosting operations
- [MULTISIG_SETUP.md](./MULTISIG_SETUP.md) for owner/pauser control-plane setup
- [AUDIT_PACKAGE.md](./AUDIT_PACKAGE.md) for external review scope and sign-off
- [THREAT_MODEL.md](./THREAT_MODEL.md) for the current launch threat model
- [NO_TOKEN.md](./NO_TOKEN.md) for the public no-token statement

If this checklist is not green, the answer is "not ready yet".

---

## 1. Control plane

- [x] `TreasuryPolicy.owner` is the intended multisig address.
- [x] `deployments/testnet-multisig-owner.json` is `status: "verified"` and matches the deployment manifest owner.
- [ ] `TreasuryPolicy.pauser` is a hot key that only holds pause power.
- [x] `./scripts/verify_deployment.sh testnet --require-owner-record-final`
  passes cleanly after `deployments/testnet.json` was updated to the live
  KMS verifier address (`0x31ad...7ab7F`).
- [ ] Pause and unpause were rehearsed from the pauser key.
- [x] At least one owner-only admin operation was rehearsed from the multisig.

See [MULTISIG_SETUP.md](./MULTISIG_SETUP.md) for the exact rehearsal flow.
Use the dedicated pauser proof before closing the two remaining boxes:

```bash
# Read-only capability proof: no mutation, no private key.
node scripts/ops/run-pauser-rehearsal.mjs \
  --profile testnet \
  --out docs/evidence/pauser-rehearsal-readonly-YYYY-MM-DD.json

# Live launch evidence: pauses and unpauses the deployed TreasuryPolicy.
PAUSER_PRIVATE_KEY=0x<pauser-testnet-key> \
node scripts/ops/run-pauser-rehearsal.mjs \
  --profile testnet \
  --live \
  --out docs/evidence/pauser-rehearsal-testnet-YYYY-MM-DD.json

# Validate the captured evidence before ticking checklist boxes.
node scripts/ops/check-pauser-rehearsal-evidence.mjs \
  --file docs/evidence/pauser-rehearsal-readonly-YYYY-MM-DD.json \
  --max-generated-age-hours 30

node scripts/ops/check-pauser-rehearsal-evidence.mjs \
  --file docs/evidence/pauser-rehearsal-testnet-YYYY-MM-DD.json \
  --require-live \
  --max-generated-age-hours 30
```

For mainnet or any real-funds rehearsal, add `--require-dedicated-pauser`
to both the rehearsal and evidence validation commands.
The max-age flag keeps older proof files useful for audit history without
letting stale evidence close current launch boxes.
The current testnet pauser address overlaps other testnet roles in
`deployments/testnet.json`; that is acceptable only as a bounded testnet
shortcut and must not be carried into mainnet.

Read-only evidence captured on 2026-05-21:
[`docs/evidence/pauser-rehearsal-readonly-2026-05-21.json`](evidence/pauser-rehearsal-readonly-2026-05-21.json).
It proves the live pauser can call `setPaused(bool)` and cannot call owner-only
functions, but it does not close the live pause/unpause rehearsal box.

---

## 2. Data durability

- [x] Latest Postgres backup exists and is recent. Evidence:
  `./scripts/ops/check-backup-readiness.sh --json` reports
  `components[postgres].status == "ok"` with `ageSeconds <
  maxAgeHours * 3600`, then the saved JSON passes
  `node scripts/ops/check-backup-readiness-evidence.mjs`.
- [x] Latest Redis backup exists and is recent. Same readiness check,
  `components[redis].status == "ok"` and the saved JSON validator passes.
- [ ] The monthly restore drill has been run on the current stack
  shape. Evidence: a dated line in the operator log naming both
  backup file paths used, the row count from the Postgres spot-check,
  and the key count from `DBSIZE` on the restored Redis container,
  plus a validated `docs/evidence/restore-drill-YYYY-MM-DD.json`
  artifact checked with `node scripts/ops/check-restore-drill-evidence.mjs`.
  Procedure: [BACKUP_RESTORE_DRILL.md](./BACKUP_RESTORE_DRILL.md).

Run backups (writes new snapshots):

```bash
./scripts/ops/backup-postgres.sh
./scripts/ops/backup-redis.sh
```

Or use GitHub Actions to create and prove hosted snapshots in one operator-run:
run the `Hosted Backup Snapshot Proof` workflow from the production environment.
It runs the two scripts above on the VPS, then uploads the readiness JSON and
validator result as `hosted-backup-snapshot-proof-<run-id>`.

Latest hosted proof: GitHub Actions run `26531944215` on 2026-05-27 uploaded
`hosted-backup-snapshot-proof-26531944215`. The saved readiness evidence in
[`docs/evidence/backup-readiness-hosted-2026-05-27.json`](evidence/backup-readiness-hosted-2026-05-27.json)
validated with `overallStatus: "ok"`, Postgres file
`agent-20260527-205325.sql.gz` at age 3s, and Redis file
`redis-20260527-205325.rdb.gz` at age 2s.

Run the readiness check (read-only, never restores or modifies a
backup file):

```bash
./scripts/ops/check-backup-readiness.sh
# or for machine-readable output:
./scripts/ops/check-backup-readiness.sh --json \
  > docs/evidence/backup-readiness-YYYY-MM-DD.json

node scripts/ops/check-backup-readiness-evidence.mjs \
  --file docs/evidence/backup-readiness-YYYY-MM-DD.json \
  --max-checked-age-hours 30
```

Restore procedures:

- **Monthly drill against a disposable target:**
  [BACKUP_RESTORE_DRILL.md](./BACKUP_RESTORE_DRILL.md).
- **Production restore (destructive, requires approval gate):**
  [VPS_RUNBOOK.md](../VPS_RUNBOOK.md) §Backups. Never run a
  production restore without a named operator on the keyboard, a
  second human acknowledgment in the incident channel, and a posted
  maintenance window. The drill never substitutes for that gate.

---

## 3. Hosted service health

- [x] Public site loads at `https://averray.com/`.
- [x] Discovery manifest loads at `https://averray.com/.well-known/agent-tools.json`.
- [x] Discovery manifest publish workflow reports `published` or
  `already_current` for the deployed `DiscoveryRegistry` hash. Required
  production secrets: `DISCOVERY_REGISTRY_ADDRESS`,
  `DISCOVERY_PUBLISHER_PRIVATE_KEY`, and `DISCOVERY_PUBLISH_RPC_URL`
  (or `POLKADOT_RPC_URL` / `RPC_URL`). First observed publish:
  workflow run `25546750360`, tx
  `0xe1f242d4b1aece3e18811367bd5d381f4cdc4133d0537597a81b7ece7a371b33`,
  registry version `1`.
- [x] Operator app protected shell responds at `https://app.averray.com/`.
- [x] API health is green at `https://api.averray.com/health`.
- [x] Indexer readiness is green at `https://index.averray.com/ready`.
- [x] Indexer freshness is within the accepted lag budget.
- [x] Latest `Deploy Production` workflow on `main` is green after the
  1Password SSH/basic-auth/admin-JWT cutovers.
- [ ] When an admin JWT is available, `/admin/status` reports the async XCM
  watcher lane cleanly.
- [x] Hosted scoped service-token proof passes with sanitized evidence:
  issue a least-privilege token, prove allowed and denied routes, revoke it,
  and confirm `listServiceTokens` does not expose raw token material.
  Evidence: GitHub Actions run
  [`25969321980`](https://github.com/averray-agent/agent/actions/runs/25969321980),
  archived at
  [`docs/evidence/service-token-proof-hosted-2026-05-16.json`](evidence/service-token-proof-hosted-2026-05-16.json).

Run:

```bash
./scripts/ops/check-hosted-stack.sh

# If the operator app is intentionally protected by Caddy, Cloudflare Access,
# or another browser auth layer and you do not have app-shell credentials in the
# current shell:
APP_ALLOW_PROTECTED_SHELL=1 ./scripts/ops/check-hosted-stack.sh

# Optional: include the async XCM operator lane in the smoke check
ADMIN_JWT='<admin-jwt>' ./scripts/ops/check-hosted-stack.sh

# Optional: run the hosted scoped service-token proof from GitHub Actions.
# The workflow loads ADMIN_JWT from op://prod-smoke/admin-jwt/password and
# uploads a sanitized JSON artifact named hosted-service-token-proof-<run-id>.
gh workflow run hosted-service-token-proof.yml -R averray-agent/agent --ref main

# Optional local fallback: include the scoped service-token proof and write
# sanitized evidence. Prefer the GitHub workflow when you do not already have
# an admin JWT in your local shell.
ADMIN_JWT='<admin-jwt>' \
CHECK_SERVICE_TOKEN_PROOF=1 \
SERVICE_TOKEN_PROOF_EVIDENCE_FILE=artifacts/service-token-proof.json \
./scripts/ops/check-hosted-stack.sh

# Optional: include operator-reporting instrumentation.
ADMIN_JWT='<admin-jwt>' \
CHECK_BOOTSTRAP_INSTRUMENTATION=1 \
./scripts/ops/check-hosted-stack.sh

# Optional branded-email delivery verification: require that the weekly email
# report has actually sent. Use this only after a sender domain is verified.
ADMIN_JWT='<admin-jwt>' \
CHECK_BOOTSTRAP_INSTRUMENTATION=1 \
CHECK_BOOTSTRAP_SELF_REPORT_SENT=1 \
BOOTSTRAP_SELF_REPORT_EXPECTED_FROM='<exact backend.env from>' \
BOOTSTRAP_SELF_REPORT_EXPECTED_TO='<exact backend.env to>' \
./scripts/ops/check-hosted-stack.sh

# Optional hosted email proof: send one report through the production admin
# endpoint, then require the email-delivery evidence in the same smoke run.
gh workflow run deploy-production.yml \
  -f bootstrap_self_report_send_now=1 \
  -f smoke_check_bootstrap_instrumentation=1 \
  -f smoke_check_bootstrap_self_report_sent=1 \
  -f run_hermes_post_deploy=1

# Component-scoped deploys can skip indexer checks when the indexer was not
# touched, while scheduled/full-stack smoke should keep the default.
CHECK_INDEXER=0 ./scripts/ops/check-hosted-stack.sh
```

For the GitHub production deploy workflow, set the repository/environment secret
`APP_ALLOW_PROTECTED_SHELL=1` when `app.averray.com` should return an auth
challenge instead of the public operator shell.

---

## 4. Release gate

Before tagging or promoting a serious deployment, run the combined gate:

```bash
./scripts/ops/check-release-readiness.sh testnet
```

What it does:

1. Runs frontend tests.
2. Runs backend tests.
3. Rebuilds the public Astro landing page and syncs it into `site/`.
4. Typechecks the indexer workspace.
5. Verifies the deployed contracts against the manifest for the selected profile.
6. Runs the hosted-stack smoke check. The deploy entrypoint keeps indexer
   checks for indexer/Caddy changes and full smoke-only runs, but skips them
   for unrelated component deploys so an existing indexer outage does not
   falsely mark a backend or frontend deploy as failed.
7. Preserves previously generated frontend/site output across unrelated
   component deploys. Server-local changes are only stashed if the
   fast-forward pull actually cannot proceed with them present.

Useful overrides:

```bash
# If the stack is deliberately paused during an incident rehearsal:
ALLOW_PAUSED=1 ./scripts/ops/check-release-readiness.sh testnet

# If you only want the live hosted checks from a VPS shell:
RUN_FRONTEND_TESTS=0 RUN_BACKEND_TESTS=0 RUN_SITE_BUILD=0 RUN_INDEXER_TYPECHECK=0 \
  ./scripts/ops/check-release-readiness.sh testnet

# If a staging Subscan key is configured and the XCM publisher is part of
# the release candidate:
RUN_SUBSCAN_XCM_VALIDATION=1 ./scripts/ops/check-release-readiness.sh testnet
```

---

## 5. Observability

- [ ] Backend metrics are bearer-protected and reachable with the scraper token.
- [ ] Backend Sentry is configured for the active environment.
- [ ] Frontend Sentry runtime config is set if browser error reporting is required.
- [ ] Structured logs are visible from the current deploy target.
- [ ] An alert destination is configured for hosted smoke-check failures.
- [x] [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) has named on-call ownership.
- [x] Operator self-report proof is visible after deploy and on schedule. Flip
  this box only when ALL of the following are true against the production stack:
  - The production deploy workflow completes with `run_hermes_post_deploy=1`
    and the GitHub Actions summary contains a Hermes post-deploy verification
    report with final verdict, hosted health, requested test cases, and safety
    outcome.
  - The same workflow run includes the `hermes-post-deploy-<run-id>`
    artifact, which preserves the full `hermes-post-deploy.log` beyond the
    truncated summary.
    - Verified on 2026-05-21: deploy run `26241427864` completed the Hermes
      post-deploy step and uploaded artifact `hermes-post-deploy-26241427864`
      (artifact id `7142450191`).
  - The `Hermes Operator Report` workflow has run successfully for both
    `ops_health` and `daily_operator_brief`, and each run includes a
    `hermes-operator-report-<report-kind>-<run-id>-<run-attempt>` artifact
    with the full Hermes log plus JSON evidence manifest.
    - First proof captured on 2026-05-21: workflow run
      `26211100734` succeeded with artifacts
      `hermes-operator-report-ops_health-26211100734-1` (artifact id
      `7129369151`) and
      `hermes-operator-report-daily_operator_brief-26211100734-1`
      (artifact id `7129370901`).
  - The workflow summaries or artifacts expose correlation ids with the
    `github-operator-report-<report-kind>-<run-id>-<run-attempt>` format
    and no API keys, JWTs, or provider tokens.
    - Verified against the downloaded run `26211100734` artifacts: correlation
      ids `github-operator-report-ops_health-26211100734-1` and
      `github-operator-report-daily_operator_brief-26211100734-1`; no obvious
      API key, JWT, 1Password service-account token, or SSH private-key
      patterns found.
  - This command passes:
    ```bash
    ADMIN_JWT='<admin-jwt>' \
    CHECK_BOOTSTRAP_INSTRUMENTATION=1 \
    ./scripts/ops/check-hosted-stack.sh
    ```
    - Verified on 2026-05-21: focused deploy smoke run `26241544177` loaded the
      production `ADMIN_JWT` from 1Password, ran with
      `smoke_check_bootstrap_instrumentation=1`, reached `Checking bootstrap
      instrumentation`, and ended with `Hosted stack smoke check passed.`
    - Refreshed on 2026-05-27: Deploy Production run
      [`26511414359`](https://github.com/averray-agent/agent/actions/runs/26511414359)
      loaded `ADMIN_JWT` from `op://prod-smoke/admin-jwt/password`, ran with
      `smoke_check_bootstrap_instrumentation=1`, completed Hermes post-deploy
      verification, and triggered successful Publish Discovery Manifest run
      [`26511490876`](https://github.com/averray-agent/agent/actions/runs/26511490876).
  - The smoke gate verifies `upstreamStatus` is enabled/running, exposes a
    durable evidence note plus bounded `fundedJobs` table counters, and that
    the optional `.bootstrapSelfReport` status is well-formed and sanitized.
  - `/admin/status.bootstrapSelfReport` does not contain API-key-shaped
    tokens such as `Bearer ...` or `re_...`; only the boolean
    `providerConfigured` may reveal that the provider is configured.
  - Branded email via Resend is optional/deferred. If it is later enabled, run
    the additional `CHECK_BOOTSTRAP_SELF_REPORT_SENT=1` gate with exact
    `BOOTSTRAP_SELF_REPORT_EXPECTED_FROM` / `BOOTSTRAP_SELF_REPORT_EXPECTED_TO`
    values and require `lastAttemptedAt`, `lastSuccessfulAt`, and the latest
    provider id.

### How to verify each §5 box

The first five boxes are intentionally not auto-flipped — they need
deployed-config evidence that lives outside the repo. The wiring exists in
code; only the production env vars need to be set. Record the three
observability gates as one dated artifact and validate it with
`node scripts/ops/check-observability-proof.mjs --file
docs/evidence/observability-YYYY-MM-DD.json --max-completed-age-hours 30 --json` before moving the
roadmap rows to `Proofed`. Concrete verification commands per box:

- **Backend metrics bearer-protected and reachable.** Production now fails
  closed when metrics auth is required but no token is configured. Flip this
  box only after `METRICS_BEARER_TOKEN` is configured in the production backend
  environment and this hosted gate passes:
  ```bash
  METRICS_BEARER_TOKEN='<metrics-scraper-token>' \
  CHECK_METRICS_AUTH=1 \
  ./scripts/ops/check-hosted-stack.sh
  ```
  The gate requires unauthenticated `/metrics` to return `401` and the same
  request with `Authorization: Bearer <token>` to return `200`.
- **Sentry/logging posture recorded for the active environment.** The current
  v1 posture is recorded in
  [`OBSERVABILITY_POSTURE.md`](./OBSERVABILITY_POSTURE.md): backend Sentry is
  optional/deferred unless a `SENTRY_DSN` is configured, backend 5xx capture
  always falls back to structured logs, and frontend Sentry is deferred for v1.
  If Sentry is enabled, set `SENTRY_DSN` (and optionally
  `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`) and
  verify `observability.sentry_ready` appears after backend startup.
- **Structured logs visible from the current deploy target.**
  `LOG_LEVEL=info` is set; the backend writes structured JSON via the
  default logger and records 5xx captures as
  `observability.captured_exception`. Verify the operator can read backend
  logs (via `journalctl`, `docker logs`, or the platform's log surface), then
  flip.
- **Alert destination for hosted smoke-check failures.** Set
  `ALERT_WEBHOOK_URL` (and optionally `ALERT_SERVICE_NAME`,
  `ALERT_ENVIRONMENT`) in the environment that runs
  [`scripts/ops/check-hosted-stack-and-alert.sh`](../scripts/ops/check-hosted-stack-and-alert.sh).
  Verify with a deliberate smoke failure (e.g. point `API_BASE_URL` at a
  non-existent host) and confirm the webhook receives the JSON payload.
  Flip after one verified delivery.
- **Operator self-report proof visible after deploy and on schedule.** Use
  [HERMES_OPERATOR_REPORTS.md](./HERMES_OPERATOR_REPORTS.md) as the evidence
  map. Run `Hermes Operator Report` manually with `report_kind=all` after this
  workflow lands, or wait for the next daily schedule. Flip only after both
  `ops_health` and `daily_operator_brief` reports succeed, each artifact is
  downloadable, and the hosted bootstrap instrumentation smoke above passes.

---

## 6. Launch Documentation

- [x] [THREAT_MODEL.md](./THREAT_MODEL.md) is published.
- [x] [NO_TOKEN.md](./NO_TOKEN.md) is linked from the repo root.
- [x] [WEEK12_GATE.md](./WEEK12_GATE.md) documents the week-12 gate thresholds and diagnostic order.
- [x] [DISPUTE_CODES.md](./DISPUTE_CODES.md) publishes the reason-code registry.
- [x] [ARBITRATION_MIGRATION.md](./ARBITRATION_MIGRATION.md) documents Phase 0 -> Phase 1 -> Phase 2 triggers.

---

## 7. Product proof before production claims

- [x] One complete worker loop has been run on the hosted stack:
  discover -> sign in -> preflight -> claim -> submit -> verify -> badge/profile
- [x] A schema-native job submission has been validated through
  `/jobs/validate-submission` and submitted as direct `payload.submission`
  evidence, with no `submission.output` wrapper. The operator-app gate is in
  place: `app/lib/api/guarded-submit.js` short-circuits the submit when the
  validation response is not `{ valid: true }`. The hosted worker-loop evidence
  must include both `validationReadiness` for the direct schema object and
  `invalidValidationReadiness` for a rejected `submission.output` wrapper with
  `submitAttempted=false`, plus `claimLiquidityReadiness` proving the worker's
  USDC liquid balance covered reward plus preflight claim lock before claim.
  Flip this box after the hosted run-detail surface or
  product-proof worker loop has been used to validate at least one
  structured-required job (one valid, one invalid) and the invalid attempt did
  not consume the session's submit budget. Verify with the regression tests:
  `node --test app/lib/api/guarded-submit.test.mjs scripts/ops/run-hosted-worker-loop.test.mjs scripts/ops/check-product-proof-gate.test.mjs`.
  Completed on 2026-05-17 in Deploy Production run
  `25988470399`: job `product-proof-worker-loop-1779014145578`, session
  `product-proof-worker-loop-1779014145578:0x31ad432dFe083B998c69B6dB88A984ec5207ab7F`,
  `verificationOutcome=approved`, `sessionStatus=resolved`, and the hosted
  gate accepted `/srv/agent-stack/product-proof-worker-loop-evidence.json`.
- [ ] The phase-0 dispute verdict path has been exercised on the hosted stack
  with the configured arbitrator/gateway and a recorded on-chain tx state from
  `POST /disputes/:id/verdict`. Flip this box only after running the dry-run
  *and* the live-mode proof harness against a specific open dispute on the
  hosted stack, and only when both runs print the documented evidence
  fields:

  ```bash
  # 1. Dry-run first to confirm the payload the script will submit.
  ADMIN_JWT=$op_admin_jwt \
  DISPUTE_PROOF_ID=dispute-xxxxxxxxxx \
  DISPUTE_PROOF_VERDICT=dismissed \
  DISPUTE_PROOF_RATIONALE="upstream PR merged after the verifier's rejection" \
  API_BASE_URL=https://api.averray.com \
    node scripts/ops/run-dispute-verdict-proof.mjs
  # Expect: { "mode": "dry_run", "payload": { ... } } and *no* network mutation.

  # 2. Live run - only with Pascal-approved dispute id + LIVE=1.
  ADMIN_JWT=$op_admin_jwt \
  DISPUTE_PROOF_ID=dispute-xxxxxxxxxx \
  DISPUTE_PROOF_VERDICT=dismissed \
  DISPUTE_PROOF_RATIONALE="upstream PR merged after the verifier's rejection" \
  DISPUTE_PROOF_LIVE=1 \
  API_BASE_URL=https://api.averray.com \
    node scripts/ops/run-dispute-verdict-proof.mjs
  ```

  Required live-mode evidence in the JSON output:
  - `mode = "live"`,
  - `response.verdict`, `response.reasonCode`, `response.reasoningHash`,
    and `response.metadataURI` all populated,
  - `response.chainStatus` is one of `confirmed | submitted | local_only`
    (`confirmed`/`submitted` means the on-chain `EscrowCore.resolveDispute`
    actually dispatched; `local_only` means blockchain env was not wired),
  - `persisted.status = "resolved"` and `persisted.reasoningHash` matches
    `response.reasoningHash` (proves the receipt persisted, not just echoed).

  The script refuses to act without a specific `DISPUTE_PROOF_ID` and a
  pre-existing open dispute. It never creates disputes and never iterates
  the queue. Regression covered by
  `node --test scripts/ops/run-dispute-verdict-proof.test.mjs`.
- [ ] Public discovery, schema, and trust pages reflect the current deployed behavior.
- [ ] Canonical public discovery manifest matches the API mirror.

If any of these drift, external agents will learn the wrong contract.

Run the read-only gate with:

```bash
npm run check:product-proof
```

After the hosted worker loop is complete, rerun it with
`PRODUCT_PROOF_REQUIRE_WORKER_LOOP=1` and a
`PRODUCT_PROOF_EVIDENCE_FILE`. See [PRODUCT_PROOF_GATE.md](./PRODUCT_PROOF_GATE.md)
for the evidence file shape.

---

## 8. Mainnet parameter package

- [ ] [MAINNET_PARAMETERS.md](./MAINNET_PARAMETERS.md) is still the intended launch profile.
- [ ] The private mainnet deploy env matches [deployments/mainnet.env.example](../deployments/mainnet.env.example) except for secrets and final addresses.
- [ ] Any deviation from the recommended launch values has been written down and approved before deploy.
- [ ] No operator is relying on the old testnet-friendly defaults from `deploy_contracts.sh`.

---

## 9. Mainnet blockers that still remain

This checklist improves release discipline, but it does not replace:

- external audit sign-off on the mainnet contract set
- the explicit mainnet launch profile in [MAINNET_PARAMETERS.md](./MAINNET_PARAMETERS.md)
- a real, audited strategy adapter path instead of the mock vDOT adapter
- explicit incident ownership and paging
- hardware MFA across the admin trust chain. Evidence must be captured in
  `docs/evidence/hardware-mfa-YYYY-MM-DD.json` and validated before mainnet
  launch sign-off:
  ```bash
  node scripts/ops/check-hardware-mfa-evidence.mjs \
    --file docs/evidence/hardware-mfa-YYYY-MM-DD.json \
    --max-completed-age-hours 30 \
    --json
  ```

Until those are done, treat the stack as production-like testnet, not
irreversible real-funds infrastructure.

---

## 10. Internal async XCM staging proof

- [ ] One async deposit request has been queued and settled on the hosted stack.
- [ ] One async withdraw request has been queued and settled on the hosted stack.
- [ ] One failure-path async request has been rehearsed honestly.
- [ ] `xcmSettlementWatcher.pendingCount` returns to `0` after the exercise.
- [ ] A report from the current deploy has been captured.

Run:

```bash
API_URL=https://api.averray.com \
ADMIN_JWT='<admin-jwt>' \
REQUEST_ID='<existing-request-id>' \
XCM_CAPTURE_PATH=artifacts/xcm/internal-async-xcm-report.json \
npm run exercise:async-xcm -- --mode observe --status succeeded --settled-assets 5 --settled-shares 5
```

The manual flow for creating the request itself lives in
[ASYNC_XCM_STAGING.md](./ASYNC_XCM_STAGING.md).

---

## 11. Optional external observer validation

- [ ] A staging Subscan key has been exercised against the current
  `subscan_xcm` source adapter.
- [ ] A sanitized validation report has been captured from the current
  staging deploy.
- [ ] `/xcm/outcomes/status` shows `source.type == "subscan_xcm"` for the
  environment being validated.
- [ ] `/xcm/outcomes` is serving the published external feed, not only the
  indexed fallback, when `REQUIRE_PUBLISHED=1` is used.
- [ ] Any response-field drift found during validation has been reflected
  in the adapter before promotion.

Run:

```bash
XCM_SUBSCAN_API_HOST=https://assethub-polkadot.api.subscan.io \
XCM_SUBSCAN_API_KEY=replace-me \
INDEXER_URL=https://index.averray.com \
XCM_CAPTURE_PATH=artifacts/xcm/subscan-validation-report.json \
npm run validate:subscan-xcm -- --require-published
```

---

## 12. Native observer gate

- [ ] [NATIVE_XCM_OBSERVER.md](./NATIVE_XCM_OBSERVER.md) has a completed
  correlation decision for deposit and withdrawal requests.
- [ ] One staged deposit and one staged withdrawal have native Hub/Bifrost
  evidence linked back to the Averray `requestId`.
- [ ] Captured evidence passes
  `npm run validate:native-xcm-evidence -- --file <capture.json>`.
- [ ] Deposit, withdrawal, and failure captures pass
  `npm run check:native-xcm-evidence-pack -- --deposit <deposit.json> --withdraw <withdraw.json> --failure <failure.json>`.
- [ ] Captured evidence was assembled with
  `npm run capture:native-xcm-evidence` or contains the same
  `native-xcm-observer-evidence-v1` fields.
- [ ] The observer cursor survives restart without duplicate settlement.
- [ ] Native observer output agrees with the internal
  `observe -> auto-finalize` staging flow for success and failure cases.
- [ ] Captured evidence is retained for audit and incident review.

Until this is green, Subscan or manual observation can help staging, but the
native observer is not production settlement truth.

---

## 13. Manual deploy: signer USDC liquidity preflight

Auto-triggered deploys (`workflow_run` events fired after CI on `main`) leave
`PRODUCT_PROOF_REQUIRE_WORKER_LOOP=0` and never claim a job. **Manual
`workflow_dispatch` deploys that set `product_proof_require_worker_loop=1`
run a real hosted product-proof worker loop against production**, which
calls `EscrowCore.claimJob` with the active backend signer. If that signer
has no liquid USDC inside `AgentAccountCore`, the deploy fails at the
worker-loop step *after* `Deploy production`'s smoke check has already
acquired the production lock, with this signature in the log:

```
Insufficient liquid balance for USDC
status=409; path=/jobs/claim; code=insufficient_liquidity
account: <signer wallet>, asset: USDC, assetClass: trust_backed
```

USDC is trust-backed (not auto-minted), so the loop fails closed rather
than minting; no chain or contract code is wrong.

**Before manually dispatching a deploy with the worker loop enabled:**

1. Identify the **active** backend signer wallet. After the 2026-05-16 KMS
   cutover (see
   [`docs/SECRETS_MIGRATION.md`](./SECRETS_MIGRATION.md)) the active signer
   is the KMS-derived EVM address, not the `verifier` field still recorded
   in [`deployments/testnet.json`](../deployments/testnet.json). The
   authoritative current value is the `account` field printed in a prior
   failing deploy log, or the address read from the KMS public key via
   `node scripts/ops/derive-kms-signer-address.mjs`.
2. Confirm that wallet's USDC position covers the worker-loop reward plus
   the configured claim-stake basis points. The exact minimum is the
   `required` value the failure log prints; current default is
   `0.16 USDC`.
3. If the position is short, top up the wallet via the playbook in
   [`docs/TESTNET_FUND_SIGNER.md`](./TESTNET_FUND_SIGNER.md). Note that
   doc's "read signer from `deployments/testnet.json#verifier`" line is
   stale post-KMS-cutover and should be cross-referenced against step 1 of
   this section before depositing — funding the old signer wallet will
   silently *not* unblock the deploy.
4. Re-run **Deploy Production** with the same dispatch parameters. The
   product-proof worker loop will create, claim, submit, and settle a job
   against the funded signer and write evidence under
   `PRODUCT_PROOF_EVIDENCE_FILE`.

If the worker loop is not the point of this particular dispatch, set
`product_proof_require_worker_loop=0` in the **Run workflow** form and
re-trigger; the deploy will skip the loop entirely. This is the right
choice for a non-functional dispatch (Caddy-only change, hotfix smoke,
cache invalidation) where the worker loop is not part of the test plan.

Last strict hosted proof: Deploy Production run `25988470399` on 2026-05-17
with `smoke_check_product_proof_gate=1` and
`product_proof_require_worker_loop=1`. The KMS signer
`0x31ad432dFe083B998c69B6dB88A984ec5207ab7F` reported `0.3 USDC` liquid in
`AgentAccountCore`, the worker-loop reward required `0.1 USDC`, the session
resolved, and `Product-proof gate passed`.
