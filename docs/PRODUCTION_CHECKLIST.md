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

- [ ] Latest Postgres backup exists and is restorable.
- [ ] Latest Redis backup exists and is restorable.
- [ ] The monthly restore drill has been run at least once on the current stack shape.

Use:

```bash
./scripts/ops/backup-postgres.sh
./scripts/ops/backup-redis.sh
```

Restore drills are documented in [VPS_RUNBOOK.md](../VPS_RUNBOOK.md).

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

Run:

```bash
./scripts/ops/check-hosted-stack.sh

# If the operator app is intentionally protected by Caddy, Cloudflare Access,
# or another browser auth layer and you do not have app-shell credentials in the
# current shell:
APP_ALLOW_PROTECTED_SHELL=1 ./scripts/ops/check-hosted-stack.sh

# Optional: include the async XCM operator lane in the smoke check
ADMIN_JWT='<admin-jwt>' ./scripts/ops/check-hosted-stack.sh

# Optional: include bootstrap instrumentation once backend.env has the poller,
# self-report recipient list, and email provider configured.
ADMIN_JWT='<admin-jwt>' \
CHECK_BOOTSTRAP_INSTRUMENTATION=1 \
BOOTSTRAP_SELF_REPORT_EXPECTED_FROM='<exact backend.env from>' \
BOOTSTRAP_SELF_REPORT_EXPECTED_TO='<exact backend.env to>' \
./scripts/ops/check-hosted-stack.sh

# First-delivery verification: require that the weekly report has actually sent.
ADMIN_JWT='<admin-jwt>' \
CHECK_BOOTSTRAP_INSTRUMENTATION=1 \
CHECK_BOOTSTRAP_SELF_REPORT_SENT=1 \
BOOTSTRAP_SELF_REPORT_EXPECTED_FROM='<exact backend.env from>' \
BOOTSTRAP_SELF_REPORT_EXPECTED_TO='<exact backend.env to>' \
./scripts/ops/check-hosted-stack.sh

# Hosted first-delivery proof: send one report through the production admin
# endpoint, then require the delivery evidence in the same smoke run.
gh workflow run deploy-production.yml \
  -f bootstrap_self_report_send_now=1 \
  -f smoke_check_bootstrap_instrumentation=1 \
  -f smoke_check_bootstrap_self_report_sent=1 \
  -f run_hermes_post_deploy=0

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
- [ ] Bootstrap self-report email has actually delivered. Flip this box only
  when ALL of the following are true against the production stack with a
  valid `ADMIN_JWT`:
  - This command passes:
    ```bash
    ADMIN_JWT='<admin-jwt>' \
    CHECK_BOOTSTRAP_INSTRUMENTATION=1 \
    CHECK_BOOTSTRAP_SELF_REPORT_SENT=1 \
    BOOTSTRAP_SELF_REPORT_EXPECTED_FROM='<exact backend.env from>' \
    BOOTSTRAP_SELF_REPORT_EXPECTED_TO='<exact backend.env to>' \
    ./scripts/ops/check-hosted-stack.sh
    ```
    Or the hosted production workflow passes with
    `bootstrap_self_report_send_now=1`,
    `smoke_check_bootstrap_instrumentation=1`, and
    `smoke_check_bootstrap_self_report_sent=1`.
  - The smoke gate verifies `.bootstrapSelfReport.enabled`,
    `.running`, `.providerConfigured`, `from`, `to`, `recipientCount`,
    `lastAttemptedAt`, `lastSuccessfulAt`, and the latest sent provider id.
    `lastSuccessfulAt` must be an ISO timestamp within 8 days by default
    (`BOOTSTRAP_SELF_REPORT_MAX_AGE_SEC` can tighten or relax this window).
  - The visible `from`/`to` pair matches production `backend.env` exactly
    (comma-separate `BOOTSTRAP_SELF_REPORT_EXPECTED_TO` for multiple
    recipients; no `null`s, no test addresses).
  - `/admin/status.bootstrapSelfReport` does not contain API-key-shaped
    tokens such as `Bearer ...` or `re_...`; only the boolean
    `providerConfigured` may reveal that the provider is configured.

---

## 6. Launch Documentation

- [x] [THREAT_MODEL.md](./THREAT_MODEL.md) is published.
- [x] [NO_TOKEN.md](./NO_TOKEN.md) is linked from the repo root.
- [x] [WEEK12_GATE.md](./WEEK12_GATE.md) documents the week-12 gate thresholds and diagnostic order.
- [x] [DISPUTE_CODES.md](./DISPUTE_CODES.md) publishes the reason-code registry.
- [x] [ARBITRATION_MIGRATION.md](./ARBITRATION_MIGRATION.md) documents Phase 0 -> Phase 1 -> Phase 2 triggers.

---

## 7. Product proof before production claims

- [ ] One complete worker loop has been run on the hosted stack:
  discover -> sign in -> preflight -> claim -> submit -> verify -> badge/profile
- [ ] A schema-native job submission has been validated through
  `/jobs/validate-submission` and submitted as direct `payload.submission`
  evidence, with no `submission.output` wrapper. The operator-app gate is in
  place: `app/lib/api/guarded-submit.js` short-circuits the submit when the
  validation response is not `{ valid: true }`. Flip this box after the hosted
  run-detail surface has been used to validate at least one structured-required
  job (one valid, one invalid) and the invalid attempt did not consume the
  session's submit budget. Verify with the regression test:
  `node --test app/lib/api/guarded-submit.test.mjs`.
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
