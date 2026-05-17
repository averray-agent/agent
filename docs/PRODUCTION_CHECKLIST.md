# Production Readiness Checklist

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
- [x] `./scripts/verify_deployment.sh testnet` passes cleanly.
- [ ] Pause and unpause were rehearsed from the pauser key.
- [x] At least one owner-only admin operation was rehearsed from the multisig.

See [MULTISIG_SETUP.md](./MULTISIG_SETUP.md) for the exact rehearsal flow.

---

## 2. Data durability

- [ ] Latest Postgres backup exists and is recent. Evidence:
  `./scripts/ops/check-backup-readiness.sh --json` reports
  `components[postgres].status == "ok"` with `ageSeconds <
  maxAgeHours * 3600`.
- [ ] Latest Redis backup exists and is recent. Same readiness check,
  `components[redis].status == "ok"`.
- [ ] The monthly restore drill has been run on the current stack
  shape. Evidence: a dated line in the operator log naming both
  backup file paths used, the row count from the Postgres spot-check,
  and the key count from `DBSIZE` on the restored Redis container.
  Procedure: [BACKUP_RESTORE_DRILL.md](./BACKUP_RESTORE_DRILL.md).

Run backups (writes new snapshots):

```bash
./scripts/ops/backup-postgres.sh
./scripts/ops/backup-redis.sh
```

Run the readiness check (read-only, never restores or modifies a
backup file):

```bash
./scripts/ops/check-backup-readiness.sh
# or for machine-readable output:
./scripts/ops/check-backup-readiness.sh --json
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

- [ ] Backend metrics are reachable and, if public, bearer-protected.
- [ ] Backend Sentry is configured for the active environment.
- [ ] Frontend Sentry runtime config is set if browser error reporting is required.
- [ ] Structured logs are visible from the current deploy target.
- [ ] An alert destination is configured for hosted smoke-check failures.
- [ ] [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) has named on-call ownership.
- [ ] Operator self-report proof is visible after deploy and on schedule. Flip
  this box only when ALL of the following are true against the production stack:
  - The production deploy workflow completes with `run_hermes_post_deploy=1`
    and the GitHub Actions summary contains a Hermes post-deploy verification
    report with final verdict, hosted health, requested test cases, and safety
    outcome.
  - The same workflow run includes the `hermes-post-deploy-<run-id>`
    artifact, which preserves the full `hermes-post-deploy.log` beyond the
    truncated summary.
  - The Hermes/operator surface has scheduled ops-health and daily-brief
    evidence available for the current deployment window.
  - This command passes:
    ```bash
    ADMIN_JWT='<admin-jwt>' \
    CHECK_BOOTSTRAP_INSTRUMENTATION=1 \
    ./scripts/ops/check-hosted-stack.sh
    ```
  - The smoke gate verifies `upstreamStatus` is enabled/running and that the
    optional `.bootstrapSelfReport` status is well-formed and sanitized.
  - `/admin/status.bootstrapSelfReport` does not contain API-key-shaped
    tokens such as `Bearer ...` or `re_...`; only the boolean
    `providerConfigured` may reveal that the provider is configured.
  - Branded email via Resend is optional/deferred. If it is later enabled, run
    the additional `CHECK_BOOTSTRAP_SELF_REPORT_SENT=1` gate with exact
    `BOOTSTRAP_SELF_REPORT_EXPECTED_FROM` / `BOOTSTRAP_SELF_REPORT_EXPECTED_TO`
    values and require `lastAttemptedAt`, `lastSuccessfulAt`, and the latest
    provider id.

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
