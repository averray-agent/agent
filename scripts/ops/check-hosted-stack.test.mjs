import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHECK_SCRIPT = join(REPO_ROOT, "scripts/ops/check-hosted-stack.sh");

test("docker product-proof gate can read hosted worker-loop evidence", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /PRODUCT_PROOF_EVIDENCE_FILE="\$repo_root\/\$PRODUCT_PROOF_EVIDENCE_FILE"/u,
    "relative evidence paths should be normalized before node or docker checks"
  );
  assert.match(
    script,
    /product_proof_evidence_dir="\$\(dirname "\$PRODUCT_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the host evidence directory"
  );
  assert.match(
    script,
    /mkdir -p "\$product_proof_evidence_dir"/u,
    "docker fallback should create the host evidence directory"
  );
  assert.match(
    script,
    /product_proof_docker_volume_args=\(-v "\$repo_root:\/workspace"\)/u,
    "docker fallback should keep mounting the repository"
  );
  assert.match(
    script,
    /product_proof_docker_volume_args\+=\(-v "\$product_proof_evidence_dir:\$product_proof_evidence_dir"\)/u,
    "docker fallback should mount the evidence directory at the same absolute path"
  );
  assert.match(
    script,
    /"\$\{product_proof_docker_volume_args\[@\]\}"/u,
    "docker fallback should pass the dynamic volume list to docker run"
  );
});

test("operator reporting gate keeps email optional and guards secrets", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_EXPECTED_FROM=/u,
    "optional email smoke should support an explicit expected sender check"
  );
  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_EXPECTED_TO=/u,
    "optional email smoke should support an explicit expected recipient check"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.providerConfigured \| type\) == "boolean"/u,
    "operator reporting instrumentation should expose optional email provider state"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.to \| type\) == "array"/u,
    "operator reporting instrumentation should expose a concrete recipient list"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.providerConfigured == false or/u,
    "base operator reporting smoke should not require a paid or verified email provider"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.recipientCount == \(\.bootstrapSelfReport\.to \| length\)/u,
    "recipientCount should agree with the visible recipient list when email is configured"
  );
  assert.ok(
    script.includes('test("Bearer\\\\s+[^\\\\s,}\\\\]]+|re_[A-Za-z0-9_-]{12,}"; "i")'),
    "bootstrap status should be scanned for API-key-shaped tokens"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.lastAttemptedAt \| type\) == "string"/u,
    "sent gate should require lastAttemptedAt"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.lastSuccessfulAt \| type\) == "string"/u,
    "sent gate should require lastSuccessfulAt"
  );
  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_MAX_AGE_SEC/u,
    "optional sent-email gate should bound the freshness of lastSuccessfulAt"
  );
});

test("scoped service-token proof gate is opt-in, admin-gated, and supports evidence files", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_SERVICE_TOKEN_PROOF=\$\{CHECK_SERVICE_TOKEN_PROOF:-0\}/u,
    "service-token proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_SERVICE_TOKEN_PROOF=1 requires ADMIN_JWT/u,
    "service-token proof should fail closed without an admin token"
  );
  assert.match(
    script,
    /SERVICE_TOKEN_PROOF_EVIDENCE_FILE="\$repo_root\/\$SERVICE_TOKEN_PROOF_EVIDENCE_FILE"/u,
    "relative service-token evidence paths should be normalized before node or docker checks"
  );
  assert.match(
    script,
    /service_token_proof_evidence_dir="\$\(dirname "\$SERVICE_TOKEN_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the service-token evidence host directory"
  );
  assert.match(
    script,
    /mkdir -p "\$service_token_proof_evidence_dir"/u,
    "docker fallback should create the service-token evidence host directory"
  );
  assert.match(
    script,
    /node "\$script_dir\/check-service-token-proof\.mjs"/u,
    "node path should invoke the service-token proof checker"
  );
  assert.match(
    script,
    /node scripts\/ops\/check-service-token-proof\.mjs/u,
    "docker fallback should invoke the service-token proof checker"
  );
  assert.match(
    script,
    /SERVICE_TOKEN_PROOF_CAPABILITIES="\$SERVICE_TOKEN_PROOF_CAPABILITIES"/u,
    "service-token proof should pass capability overrides through"
  );
  assert.match(
    script,
    /service_token_proof_docker_volume_args\+=\(-v "\$service_token_proof_evidence_dir:\$service_token_proof_evidence_dir"\)/u,
    "docker fallback should mount service-token evidence at the same absolute path"
  );
});

test("external schema proof gate is opt-in, admin-gated, and supports evidence files", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_EXTERNAL_SCHEMA_PROOF=\$\{CHECK_EXTERNAL_SCHEMA_PROOF:-0\}/u,
    "external-schema proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_EXTERNAL_SCHEMA_PROOF=1 requires ADMIN_JWT/u,
    "external-schema proof should fail closed without an admin token"
  );
  assert.match(
    script,
    /EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE="\$repo_root\/\$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE"/u,
    "relative external-schema evidence paths should be normalized before node or docker checks"
  );
  assert.match(
    script,
    /external_schema_proof_evidence_dir="\$\(dirname "\$EXTERNAL_SCHEMA_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the external-schema evidence host directory"
  );
  assert.match(
    script,
    /mkdir -p "\$external_schema_proof_evidence_dir"/u,
    "docker fallback should create the external-schema evidence host directory"
  );
  assert.match(
    script,
    /node "\$script_dir\/check-external-schema-registration-proof\.mjs"/u,
    "node path should invoke the external-schema proof checker"
  );
  assert.match(
    script,
    /node scripts\/ops\/check-external-schema-registration-proof\.mjs/u,
    "docker fallback should invoke the external-schema proof checker"
  );
  assert.match(
    script,
    /EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY="\$EXTERNAL_SCHEMA_PROOF_IDEMPOTENCY_KEY"/u,
    "external-schema proof should pass idempotency override through"
  );
  assert.match(
    script,
    /external_schema_proof_docker_volume_args\+=\(-v "\$external_schema_proof_evidence_dir:\$external_schema_proof_evidence_dir"\)/u,
    "docker fallback should mount external-schema evidence at the same absolute path"
  );
});

test("metrics auth gate is opt-in and verifies both denied and allowed scrapes", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_METRICS_AUTH=\$\{CHECK_METRICS_AUTH:-0\}/u,
    "metrics auth proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_METRICS_AUTH=1 requires METRICS_BEARER_TOKEN/u,
    "metrics auth proof should fail closed without the scraper token"
  );
  assert.match(
    script,
    /Expected unauthenticated \/metrics to return 401/u,
    "metrics auth proof should require no-bearer requests to be denied"
  );
  assert.match(
    script,
    /authorization: Bearer \$METRICS_BEARER_TOKEN/u,
    "metrics auth proof should send the scraper bearer token"
  );
  assert.match(
    script,
    /Expected bearer-authenticated \/metrics to return 200/u,
    "metrics auth proof should require bearer-authenticated scrapes to work"
  );
});

test("dispute verdict proof gate is opt-in, live-only, and requires chain dispatch", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_DISPUTE_VERDICT_PROOF=\$\{CHECK_DISPUTE_VERDICT_PROOF:-0\}/u,
    "dispute verdict proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_DISPUTE_VERDICT_PROOF=1 requires ADMIN_JWT or AVERRAY_TOKEN/u,
    "dispute verdict proof should fail closed without an authenticated operator token"
  );
  assert.match(
    script,
    /CHECK_DISPUTE_VERDICT_PROOF=1 requires DISPUTE_PROOF_LIVE=1/u,
    "hosted proof should not accept dry-run output as launch evidence"
  );
  assert.match(
    script,
    /DISPUTE_PROOF_REQUIRE_CHAIN=1/u,
    "hosted proof should require confirmed/submitted chain dispatch, not local_only receipts"
  );
  assert.match(
    script,
    /DISPUTE_PROOF_JSON_ONLY=1/u,
    "hosted proof should request machine-readable JSON without progress logs"
  );
  assert.match(
    script,
    /run-dispute-verdict-proof\.mjs/u,
    "hosted proof should invoke the dispute verdict proof harness"
  );
  assert.match(
    script,
    /\.response\.chainStatus == "confirmed" or \.response\.chainStatus == "submitted"/u,
    "hosted proof should only accept confirmed or submitted chain status"
  );
  assert.match(
    script,
    /\.persisted\.reasoningHash == \.response\.reasoningHash/u,
    "hosted proof should assert persistence matches the verdict response"
  );
});

test("admin async XCM smoke verifies the watcher lane is publishing, not just configured", async () => {
  // Structural lock-in for the PROJECT_ROADMAP.md P0 row "Hosted
  // /admin/status async XCM smoke" — the close criterion is "Run
  // hosted check with live admin JWT and verify async XCM watcher
  // lane". Before this PR the smoke asserted only .enabled == true on
  // the watcher; that proves the watcher was wired in at backend
  // construction, not that the polling loop is alive. The new
  // assertion adds .running == true.
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /\.xcmSettlementWatcher\.running == true/u,
    "admin async XCM smoke must assert .xcmSettlementWatcher.running == true so a watcher whose start() never ran fails the deploy."
  );
  assert.match(
    script,
    /settlement watcher loop is not alive/u,
    "smoke must surface a clear operator-facing error when .running is false."
  );
});

test("admin async XCM smoke gates xcmObservationRelay on running + no lastError when enabled", async () => {
  // The observation relay is the upstream observer-feed poll loop. A
  // sticky lastError indicates the backend can't reach the observer
  // feed and async XCM settlement is silently degraded. Smoke must
  // catch this before the operator does.
  const script = await readFile(CHECK_SCRIPT, "utf8");

  // The conditional shape: either disabled, or (running AND empty
  // lastError). Disabled means the deploy intentionally didn't wire
  // the relay — that's not a smoke failure.
  assert.match(
    script,
    /\.xcmObservationRelay\.enabled == false or\s*\([\s\S]{0,200}\.xcmObservationRelay\.running == true and\s*\([\s\S]{0,200}\.xcmObservationRelay\.lastError == null or \(\.xcmObservationRelay\.lastError \| tostring \| length\) == 0/u,
    "xcmObservationRelay assertion must be (disabled OR (running AND empty lastError))."
  );
  assert.match(
    script,
    /upstream observer feed broken/u,
    "smoke must surface a clear operator-facing error when the relay is enabled but lastError is non-empty."
  );
});

test("admin async XCM smoke has an optional freshness gate on xcmObservationRelay.lastSyncedAt", async () => {
  // Freshness gate proves the relay is polling at the expected
  // cadence — a relay that's "running: true" but whose loop has
  // stalled would otherwise pass the previous assertion. Gate is
  // off when relay is disabled or lastSyncedAt is null (freshly
  // restarted, hasn't polled yet). Default 1800s (30 min) — 2× a
  // 15-min poll interval gives headroom; tunable via
  // XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC.
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC:-1800/u,
    "freshness gate must have a default staleness budget (1800s) and be tunable via XCM_OBSERVATION_RELAY_MAX_STALENESS_SEC."
  );
  assert.match(
    script,
    /\.xcmObservationRelay\.lastSyncedAt == null/u,
    "freshness gate must skip when lastSyncedAt is null (relay never polled yet — not a failure)."
  );
  assert.match(
    script,
    /relay is not polling at the expected cadence/u,
    "freshness gate must surface a clear operator-facing error when the cadence has stalled."
  );
});
